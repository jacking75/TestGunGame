using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

namespace TestGunGame.Host
{
    /// <summary>
    /// Wii 리모컨(및 호환품)을 Windows 블루투스에 등록한다. Windows 설정 창은 PIN을 요구하지만
    /// Wii 리모컨 PIN은 블루투스 주소 6바이트라 키보드로 넣을 수 없다. 흔한 방식부터 차례로 시도한다.
    ///   방식: ① SYNC PIN(PC 주소 역순, 영구 등록) → ② 인증 없이 HID 연결(임시, 매번 자동 재연결)
    ///         → ③ 1+2 PIN(리모컨 주소 역순) → ④ "0000"(일부 호환품). 각 시도는 제한 시간을 넘기면 다음으로 넘어간다.
    ///   장치: ① 이름 "Nintendo RVL-CNT" → ② 이름에 RVL·Nintendo·Wii → ③ 이름 없는 조이스틱·게임패드 종류 장치
    /// </summary>
    internal sealed class WiimotePairing
    {
        private static readonly string[] PinMethods = { "sync", "direct", "one-two", "0000" };
        /// <summary>등록 함수가 응답하지 않을 때 기다리는 최대 시간</summary>
        private const int AuthTimeoutMs = 10000;
        private const int ERROR_SUCCESS = 0;

        private readonly Action<Dictionary<string, object>> progress;
        private volatile bool cancelled;

        public WiimotePairing(Action<Dictionary<string, object>> progress)
        {
            this.progress = progress;
        }

        public void Cancel() => cancelled = true;

        /// <returns>paired | already | timeout | cancelled | no-radio</returns>
        public string Run(int seconds)
        {
            IntPtr radio = FindRadio(out ulong hostAddress, out string radioName);
            if (radio == IntPtr.Zero)
            {
                Report("no-radio", "PC에서 블루투스를 찾지 못했습니다. 블루투스가 켜져 있는지 확인하세요.");
                return "no-radio";
            }
            try
            {
                Report("radio", radioName, ("address", Mac(hostAddress)));
                RemoveStale(radio);
                var attempts = new Dictionary<ulong, int>();
                DateTime deadline = DateTime.UtcNow.AddSeconds(seconds);
                Report("searching", "리모컨을 찾는 중");
                while (DateTime.UtcNow < deadline)
                {
                    if (cancelled) return "cancelled";
                    foreach (var dev in FindCandidates(radio, true))
                    {
                        if (cancelled) return "cancelled";
                        var d = dev;
                        if (d.fAuthenticated != 0 && d.fConnected != 0)
                        {
                            Report("already", d.szName, ("address", Mac(d.Address)));
                            return "already";
                        }
                        if (d.fAuthenticated != 0)
                        {
                            // 예전에 등록된 리모컨: HID 서비스만 다시 켠다. 안 되면 지우고 새로 등록한다.
                            if (EnableHid(radio, ref d)) return Done(d, "existing");
                            ulong a = d.Address;
                            Native.BluetoothRemoveDevice(ref a);
                            Report("re-register", d.szName, ("address", Mac(d.Address)));
                            continue;
                        }

                        attempts.TryGetValue(d.Address, out int tried);
                        string method = PinMethods[tried % PinMethods.Length];
                        attempts[d.Address] = tried + 1;
                        Report("found", d.szName, ("address", Mac(d.Address)), ("method", method), ("attempt", tried + 1));
                        if (method == "direct")
                        {
                            // 인증 없이 HID 서비스만 켠다. 리모컨이 검색 가능 상태(LED 깜박임)일 때 연결된다.
                            if (EnableHid(radio, ref d)) return Done(d, method);
                            Report("retry", "다른 방식으로 다시 시도합니다. 리모컨 LED가 꺼졌으면 SYNC 버튼을 다시 누르세요.");
                            continue;
                        }
                        byte[] pin = Pin(method, hostAddress, d.Address);
                        int r = AuthenticateWithTimeout(radio, d, pin, out string requested, out d);
                        Report("authenticate", method, ("result", r), ("requested", requested));
                        if (r != ERROR_SUCCESS)
                        {
                            Report("retry", "다른 방식으로 다시 시도합니다. 리모컨 LED가 꺼졌으면 SYNC 버튼을 다시 누르세요.");
                            continue;
                        }
                        if (EnableHid(radio, ref d)) return Done(d, method);
                    }
                }
                Report("timeout", "리모컨을 찾지 못했습니다.");
                return "timeout";
            }
            finally
            {
                Native.CloseHandle(radio);
            }
        }

        private string Done(Native.BLUETOOTH_DEVICE_INFO d, string method)
        {
            Report("paired", d.szName, ("address", Mac(d.Address)), ("method", method));
            return "paired";
        }

        private bool EnableHid(IntPtr radio, ref Native.BLUETOOTH_DEVICE_INFO d)
        {
            Guid hid = Native.HidServiceClass;
            int r = Native.BluetoothSetServiceState(radio, ref d, ref hid, 1);
            Report("hid-service", d.szName, ("result", r));
            // 87(잘못된 매개 변수)은 이미 켜져 있는 경우에도 돌아온다.
            return r == ERROR_SUCCESS || r == 87;
        }

        private static byte[] Pin(string method, ulong host, ulong device)
        {
            if (method == "0000") return new byte[] { 0x30, 0x30, 0x30, 0x30 };
            // 주소의 낮은 바이트부터 6개 = 사람이 읽는 주소를 거꾸로 한 순서. 0x00·0x80 이상 값도 그대로 보낸다.
            byte[] b = BitConverter.GetBytes(method == "sync" ? host : device);
            var pin = new byte[6];
            Array.Copy(b, pin, 6);
            return pin;
        }

        /// <summary>등록 함수가 멈추는 장치·스택이 있어 제한 시간을 둔다. 시간이 지나면 1460(시간 초과)을 돌려준다.</summary>
        private int AuthenticateWithTimeout(IntPtr radio, Native.BLUETOOTH_DEVICE_INFO device, byte[] pin, out string requested, out Native.BLUETOOTH_DEVICE_INFO updated)
        {
            var dev = device;
            string req = "";
            var task = System.Threading.Tasks.Task.Run(() =>
            {
                int r = Authenticate(radio, ref dev, pin, out string q);
                req = q;
                return r;
            });
            if (!task.Wait(AuthTimeoutMs))
            {
                requested = "timeout";
                updated = device;
                return 1460;
            }
            requested = req;
            updated = dev;
            return task.Result;
        }

        /// <summary>
        /// 인증 콜백을 등록하고 등록을 시작한다. 장치가 PIN(레거시)을 요구하면 원본 바이트 PIN으로,
        /// 숫자 비교·알림 방식(일부 호환품)을 요구하면 수락으로 응답한다. Windows 확인 창은 뜨지 않는다.
        /// </summary>
        private int Authenticate(IntPtr radio, ref Native.BLUETOOTH_DEVICE_INFO device, byte[] pin, out string requested)
        {
            string req = "none";
            int infoSize = Marshal.SizeOf(typeof(Native.BLUETOOTH_DEVICE_INFO));
            Native.AuthenticationCallbackEx callback = (param, cbParams) =>
            {
                ulong remote = (ulong)Marshal.ReadInt64(cbParams, 8);
                int method = Marshal.ReadInt32(cbParams, infoSize);
                uint numeric = (uint)Marshal.ReadInt32(cbParams, infoSize + 12);
                req = method.ToString();
                Report("auth-callback", "인증 요청 받음", ("method", method));
                IntPtr resp = Native.BuildAuthResponse(remote, method, pin, numeric);
                try
                {
                    int sr = Native.BluetoothSendAuthenticationResponseEx(radio, resp);
                    req += ":" + sr;
                }
                finally
                {
                    Marshal.FreeHGlobal(resp);
                }
                return true;
            };
            int reg = Native.BluetoothRegisterForAuthenticationEx(ref device, out IntPtr handle, callback, IntPtr.Zero);
            if (reg != ERROR_SUCCESS)
            {
                requested = "register-failed:" + reg;
                return reg;
            }
            try
            {
                int r = Native.BluetoothAuthenticateDeviceEx(IntPtr.Zero, radio, ref device, IntPtr.Zero, Native.MITMProtectionNotRequired);
                requested = req;
                return r;
            }
            finally
            {
                Native.BluetoothUnregisterAuthentication(handle);
                GC.KeepAlive(callback);
            }
        }

        private static IntPtr FindRadio(out ulong address, out string name)
        {
            address = 0;
            name = "";
            var fp = new Native.BLUETOOTH_FIND_RADIO_PARAMS { dwSize = Marshal.SizeOf(typeof(Native.BLUETOOTH_FIND_RADIO_PARAMS)) };
            IntPtr find = Native.BluetoothFindFirstRadio(ref fp, out IntPtr radio);
            if (find == IntPtr.Zero) return IntPtr.Zero;
            Native.BluetoothFindRadioClose(find);
            var info = new Native.BLUETOOTH_RADIO_INFO { dwSize = Marshal.SizeOf(typeof(Native.BLUETOOTH_RADIO_INFO)) };
            if (Native.BluetoothGetRadioInfo(radio, ref info) != ERROR_SUCCESS)
            {
                Native.CloseHandle(radio);
                return IntPtr.Zero;
            }
            address = info.address;
            name = info.szName;
            return radio;
        }

        /// <summary>등록을 시도했다가 실패해 반쯤 남은 항목을 지운다(Windows 설정에서 PIN 없이 시도한 경우 등).</summary>
        private void RemoveStale(IntPtr radio)
        {
            foreach (var d in FindCandidates(radio, false))
            {
                if (d.fAuthenticated != 0) continue;
                ulong a = d.Address;
                int r = Native.BluetoothRemoveDevice(ref a);
                Report("removed-stale", d.szName, ("address", Mac(d.Address)), ("result", r));
            }
        }

        private static List<Native.BLUETOOTH_DEVICE_INFO> FindCandidates(IntPtr radio, bool inquiry)
        {
            var all = new List<Native.BLUETOOTH_DEVICE_INFO>();
            var sp = new Native.BLUETOOTH_DEVICE_SEARCH_PARAMS
            {
                dwSize = Marshal.SizeOf(typeof(Native.BLUETOOTH_DEVICE_SEARCH_PARAMS)),
                fReturnAuthenticated = 1,
                fReturnRemembered = 1,
                fReturnUnknown = 1,
                fReturnConnected = 1,
                fIssueInquiry = inquiry ? 1 : 0,
                cTimeoutMultiplier = 2,
                hRadio = radio,
            };
            var di = NewDeviceInfo();
            IntPtr find = Native.BluetoothFindFirstDevice(ref sp, ref di);
            if (find == IntPtr.Zero) return all;
            do
            {
                all.Add(di);
                di = NewDeviceInfo();
            } while (Native.BluetoothFindNextDevice(find, ref di));
            Native.BluetoothFindDeviceClose(find);

            // 흔한 이름부터: 정품 이름 → 호환품 이름 → 이름 없는 게임패드 종류
            var result = all.FindAll(d => Rank(d) == 1);
            if (result.Count == 0) result = all.FindAll(d => Rank(d) == 2);
            if (result.Count == 0) result = all.FindAll(d => Rank(d) == 3);
            return result;
        }

        private static int Rank(Native.BLUETOOTH_DEVICE_INFO d)
        {
            string n = d.szName ?? "";
            if (n.IndexOf("RVL-WBC", StringComparison.OrdinalIgnoreCase) >= 0) return 0; // 밸런스 보드 제외
            if (n.StartsWith("Nintendo RVL-CNT", StringComparison.OrdinalIgnoreCase)) return 1;
            if (n.IndexOf("RVL", StringComparison.OrdinalIgnoreCase) >= 0 ||
                n.IndexOf("Nintendo", StringComparison.OrdinalIgnoreCase) >= 0 ||
                n.IndexOf("Wii", StringComparison.OrdinalIgnoreCase) >= 0) return 2;
            // 장치 종류: 주변기기(0x05) 중 조이스틱(1)·게임패드(2). 정품 리모컨은 0x002504.
            uint major = (d.ulClassofDevice >> 8) & 0x1F;
            uint minor = (d.ulClassofDevice >> 2) & 0x0F;
            if (n.Length == 0 && d.fAuthenticated == 0 && major == 0x05 && (minor == 1 || minor == 2)) return 3;
            return 0;
        }

        private static Native.BLUETOOTH_DEVICE_INFO NewDeviceInfo() =>
            new Native.BLUETOOTH_DEVICE_INFO { dwSize = Marshal.SizeOf(typeof(Native.BLUETOOTH_DEVICE_INFO)) };

        private static string Mac(ulong a)
        {
            byte[] b = BitConverter.GetBytes(a);
            return string.Format("{0:X2}:{1:X2}:{2:X2}:{3:X2}:{4:X2}:{5:X2}", b[5], b[4], b[3], b[2], b[1], b[0]);
        }

        private void Report(string stage, string message, params (string key, object value)[] extra)
        {
            var o = new Dictionary<string, object> { ["stage"] = stage, ["message"] = message };
            foreach (var (k, v) in extra) o[k] = v;
            progress(o);
        }
    }
}
