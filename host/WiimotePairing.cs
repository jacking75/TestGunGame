using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

namespace TestGunGame.Host
{
    /// <summary>
    /// Wii 리모컨(및 호환품)을 Windows 블루투스에 등록한다. Windows 설정 창은 PIN을 요구하지만
    /// Wii 리모컨 PIN은 블루투스 주소 6바이트라 키보드로 넣을 수 없어 게임이 직접 등록한다.
    ///
    /// 순서(2026-10-22):
    ///   ① 인증 없이 목록에만 남은 항목을 지운다(그대로 두면 다시 연결할 방법이 없다).
    ///   ② 영구 등록 시도: SYNC로 검색 상태가 된 리모컨에 PIN = PC 블루투스 주소 6바이트(낮은 바이트부터)를
    ///      인증 콜백(BluetoothRegisterForAuthenticationEx)에서 원본 바이트 그대로 응답한다. 성공하면
    ///      BluetoothEnumerateInstalledServices를 호출해야 리모컨이 등록을 기억한다(Dolphin·WiiPair).
    ///   ③ 영구 등록이 실패하거나 제한 시간을 넘기면 같은 SYNC 안에서 바로 인증 없이 HID만 켜는 임시 연결을 한다.
    ///      리모컨 검색 상태는 약 20초뿐이고, 인증 실패 뒤에는 Windows가 연결을 끊어 검색 상태가 풀리므로 미루면 안 된다.
    ///   이미 영구 등록된 리모컨은 아무 버튼으로 스스로 연결해 오므로 등록을 지우지 않고 기다린다.
    ///   장치: ① 이름 "Nintendo RVL-CNT" → ② 이름에 RVL·Nintendo·Wii → ③ 이름 없는 조이스틱·게임패드 종류 장치
    /// </summary>
    internal sealed class WiimotePairing
    {
        /// <summary>한 리모컨에 영구 등록을 시도하는 횟수. 그 뒤로는 임시 연결만 한다.</summary>
        private const int PermanentTries = 2;
        /// <summary>인증 함수가 응답하지 않을 때 기다리는 최대 시간. 남은 검색 시간 안에 임시 연결할 여유를 둔다.</summary>
        private const int AuthTimeoutMs = 6000;
        private const int ERROR_SUCCESS = 0;

        private readonly Action<Dictionary<string, object>> progress;
        private volatile bool cancelled;
        /// <summary>끝나지 않은 인증. 끝날 때까지 새 인증을 시작하지 않는다.</summary>
        private Task<int> pendingAuth;

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
                            // 영구 등록된 리모컨: 리모컨 버튼을 누르면 스스로 연결해 온다. HID 서비스만 켜 둔다.
                            // 꺼져 있어 실패해도 등록은 지우지 않는다(지우면 다시 SYNC가 필요해진다).
                            EnableHid(radio, ref d);
                            Report("waiting-remembered", d.szName, ("address", Mac(d.Address)));
                            continue;
                        }

                        attempts.TryGetValue(d.Address, out int tried);
                        attempts[d.Address] = tried + 1;
                        bool tryPermanent = tried < PermanentTries && (pendingAuth == null || pendingAuth.IsCompleted);
                        Report("found", d.szName, ("address", Mac(d.Address)), ("method", tryPermanent ? "sync" : "direct"), ("attempt", tried + 1));

                        if (tryPermanent)
                        {
                            int r = AuthenticateWithTimeout(radio, d, SyncPin(hostAddress), out d);
                            bool authed = r == ERROR_SUCCESS || IsAuthenticated(radio, ref d);
                            Report("authenticate", "sync", ("result", r), ("authenticated", authed), ("attempt", tried + 1));
                            if (authed)
                            {
                                // 이 호출이 있어야 리모컨이 등록(PC 주소)을 기억한다.
                                int count = 0;
                                int s = Native.BluetoothEnumerateInstalledServices(radio, ref d, ref count, IntPtr.Zero);
                                Report("services", d.szName, ("result", s), ("count", count));
                                if (EnableHid(radio, ref d)) return Done(d, "sync", true);
                            }
                        }

                        // 임시 연결: 인증 없이 HID 서비스만 켠다. 리모컨이 검색 가능 상태(LED 깜박임)일 때 연결된다.
                        if (EnableHid(radio, ref d)) return Done(d, "direct", false);
                        Report("retry", "다시 시도합니다. 리모컨 LED가 꺼졌으면 SYNC 버튼을 다시 누르세요.");
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

        private string Done(Native.BLUETOOTH_DEVICE_INFO d, string method, bool permanent)
        {
            Report("paired", d.szName, ("address", Mac(d.Address)), ("method", method), ("permanent", permanent));
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

        private static bool IsAuthenticated(IntPtr radio, ref Native.BLUETOOTH_DEVICE_INFO d)
        {
            var q = d;
            q.dwSize = Marshal.SizeOf(typeof(Native.BLUETOOTH_DEVICE_INFO));
            if (Native.BluetoothGetDeviceInfo(radio, ref q) != ERROR_SUCCESS) return false;
            d = q;
            return q.fAuthenticated != 0;
        }

        /// <summary>SYNC PIN = PC 블루투스 주소 6바이트, 낮은 바이트부터(사람이 읽는 주소를 거꾸로 한 순서)</summary>
        private static byte[] SyncPin(ulong host)
        {
            var pin = new byte[6];
            Array.Copy(BitConverter.GetBytes(host), pin, 6);
            return pin;
        }

        /// <summary>인증 함수가 끝나지 않는 경우가 있어 제한 시간을 둔다. 시간이 지나면 1460(시간 초과)을 돌려준다.</summary>
        private int AuthenticateWithTimeout(IntPtr radio, Native.BLUETOOTH_DEVICE_INFO device, byte[] pin, out Native.BLUETOOTH_DEVICE_INFO updated)
        {
            var dev = device;
            var task = Task.Run(() => Authenticate(radio, ref dev, pin));
            pendingAuth = task;
            if (!task.Wait(AuthTimeoutMs))
            {
                updated = device;
                return 1460;
            }
            updated = dev;
            return task.Result;
        }

        /// <summary>
        /// 인증 콜백을 등록하고 등록을 시작한다. 리모컨이 PIN(레거시, 방식 1)을 요구하면 원본 바이트 PIN으로 응답한다.
        /// Windows 확인 창은 뜨지 않는다. 응답 함수의 결과는 원인 분석용으로 모두 기록한다.
        /// </summary>
        private int Authenticate(IntPtr radio, ref Native.BLUETOOTH_DEVICE_INFO device, byte[] pin)
        {
            int infoSize = Marshal.SizeOf(typeof(Native.BLUETOOTH_DEVICE_INFO));
            Native.AuthenticationCallbackEx callback = (param, cbParams) =>
            {
                ulong remote = (ulong)Marshal.ReadInt64(cbParams, 8);
                int method = Marshal.ReadInt32(cbParams, infoSize);
                IntPtr resp = Native.BuildPinResponse(remote, pin);
                try
                {
                    // 첫 시도(2026-10-20)는 라디오 핸들을 넘긴 뒤 인증 함수가 멈췄다. 이번에는 NULL(모든 라디오)로 보낸다.
                    int sr = Native.BluetoothSendAuthenticationResponseEx(IntPtr.Zero, resp);
                    Report("auth-response", "인증 요청에 PIN으로 응답", ("method", method), ("result", sr), ("lastError", Marshal.GetLastWin32Error()));
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
                Report("auth-register", "인증 콜백 등록 실패", ("result", reg));
                return reg;
            }
            try
            {
                return Native.BluetoothAuthenticateDeviceEx(IntPtr.Zero, radio, ref device, IntPtr.Zero, Native.MITMProtectionNotRequired);
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
