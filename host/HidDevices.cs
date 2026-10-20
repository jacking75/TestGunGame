using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace TestGunGame.Host
{
    internal sealed class HidInfo
    {
        public string path;
        public int vendorId;
        public int productId;
        public string productName;
        public int inputLength;
        public int outputLength;
    }

    /// <summary>
    /// HID 장치 열거와 원본 보고서 송수신. 프로토콜 해석은 게임(TypeScript)이 맡는다.
    /// 쓰기는 장치·블루투스 스택마다 되는 방식이 달라 WriteFile → HidD_SetOutputReport 순서로 시도하고, 성공한 방식을 기억한다.
    /// </summary>
    internal static class HidDevices
    {
        public static List<HidInfo> List()
        {
            var result = new List<HidInfo>();
            Native.HidD_GetHidGuid(out Guid hidGuid);
            IntPtr set = Native.SetupDiGetClassDevs(ref hidGuid, IntPtr.Zero, IntPtr.Zero, Native.DIGCF_PRESENT | Native.DIGCF_DEVICEINTERFACE);
            if (set == new IntPtr(-1)) return result;
            try
            {
                var data = new Native.SP_DEVICE_INTERFACE_DATA { cbSize = Marshal.SizeOf(typeof(Native.SP_DEVICE_INTERFACE_DATA)) };
                for (int i = 0; Native.SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref hidGuid, i, ref data); i++)
                {
                    string path = DevicePath(set, ref data);
                    if (path == null) continue;
                    HidInfo info = Describe(path);
                    if (info != null) result.Add(info);
                }
            }
            finally
            {
                Native.SetupDiDestroyDeviceInfoList(set);
            }
            return result;
        }

        private static string DevicePath(IntPtr set, ref Native.SP_DEVICE_INTERFACE_DATA data)
        {
            Native.SetupDiGetDeviceInterfaceDetail(set, ref data, IntPtr.Zero, 0, out int size, IntPtr.Zero);
            if (size <= 0) return null;
            IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                // SP_DEVICE_INTERFACE_DETAIL_DATA_W.cbSize: x64 = 8, x86 = 6
                Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6);
                if (!Native.SetupDiGetDeviceInterfaceDetail(set, ref data, buf, size, out _, IntPtr.Zero)) return null;
                return Marshal.PtrToStringUni(buf + 4);
            }
            finally
            {
                Marshal.FreeHGlobal(buf);
            }
        }

        /// <summary>장치를 열지 않고(접근 0) 속성만 읽는다. 키보드·마우스처럼 독점된 장치도 목록에는 나온다.</summary>
        private static HidInfo Describe(string path)
        {
            using (SafeFileHandle h = Native.CreateFile(path, 0, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE, IntPtr.Zero, Native.OPEN_EXISTING, 0, IntPtr.Zero))
            {
                if (h.IsInvalid) return null;
                var attr = new Native.HIDD_ATTRIBUTES { Size = Marshal.SizeOf(typeof(Native.HIDD_ATTRIBUTES)) };
                if (!Native.HidD_GetAttributes(h, ref attr)) return null;
                var info = new HidInfo { path = path, vendorId = attr.VendorID, productId = attr.ProductID, productName = "" };
                var name = new byte[256];
                if (Native.HidD_GetProductString(h, name, name.Length))
                {
                    // 버퍼 뒤쪽은 초기화되지 않은 값일 수 있으므로 첫 null에서 자른다.
                    string s = Encoding.Unicode.GetString(name);
                    int end = s.IndexOf('\0');
                    info.productName = end >= 0 ? s.Substring(0, end) : s;
                }
                if (Native.HidD_GetPreparsedData(h, out IntPtr pp))
                {
                    if (Native.HidP_GetCaps(pp, out Native.HIDP_CAPS caps) == 0x00110000)
                    {
                        info.inputLength = caps.InputReportByteLength;
                        info.outputLength = caps.OutputReportByteLength;
                    }
                    Native.HidD_FreePreparsedData(pp);
                }
                return info;
            }
        }
    }

    /// <summary>열린 HID 장치 하나. 읽기와 쓰기는 서로 막지 않도록 핸들을 따로 연다.</summary>
    internal sealed class HidConnection : IDisposable
    {
        private enum WriteMode { Unknown, WriteFile, SetOutputReport }

        public readonly int Id;
        public readonly HidInfo Info;
        private readonly SafeFileHandle readHandle;
        private readonly SafeFileHandle writeHandle;
        private readonly Thread reader;
        private readonly Action<int, byte[]> onReport;
        private readonly Action<int, string> onClosed;
        private readonly object writeLock = new object();
        private WriteMode writeMode = WriteMode.Unknown;
        private volatile bool closing;

        public string WriteMethod => writeMode.ToString();

        public HidConnection(int id, HidInfo info, Action<int, byte[]> onReport, Action<int, string> onClosed)
        {
            Id = id;
            Info = info;
            this.onReport = onReport;
            this.onClosed = onClosed;
            uint share = Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE;
            readHandle = Native.CreateFile(info.path, Native.GENERIC_READ | Native.GENERIC_WRITE, share, IntPtr.Zero, Native.OPEN_EXISTING, 0, IntPtr.Zero);
            if (readHandle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "장치를 열 수 없습니다");
            writeHandle = Native.CreateFile(info.path, Native.GENERIC_READ | Native.GENERIC_WRITE, share, IntPtr.Zero, Native.OPEN_EXISTING, 0, IntPtr.Zero);
            if (writeHandle.IsInvalid)
            {
                int err = Marshal.GetLastWin32Error();
                readHandle.Dispose();
                throw new Win32Exception(err, "장치를 열 수 없습니다");
            }
            reader = new Thread(ReadLoop) { IsBackground = true, Name = "hid-read-" + id };
            reader.Start();
        }

        public void Write(byte reportId, byte[] data)
        {
            int len = Math.Max(Info.outputLength, data.Length + 1);
            var buf = new byte[len];
            buf[0] = reportId;
            Array.Copy(data, 0, buf, 1, Math.Min(data.Length, len - 1));
            lock (writeLock)
            {
                if (writeMode != WriteMode.SetOutputReport)
                {
                    if (Native.WriteFile(writeHandle, buf, buf.Length, out _, IntPtr.Zero))
                    {
                        writeMode = WriteMode.WriteFile;
                        return;
                    }
                    if (writeMode == WriteMode.WriteFile) throw new Win32Exception(Marshal.GetLastWin32Error(), "보고서 전송 실패");
                }
                if (Native.HidD_SetOutputReport(writeHandle, buf, buf.Length))
                {
                    writeMode = WriteMode.SetOutputReport;
                    return;
                }
                throw new Win32Exception(Marshal.GetLastWin32Error(), "보고서 전송 실패");
            }
        }

        private void ReadLoop()
        {
            var buf = new byte[Math.Max(Info.inputLength, 64)];
            string reason = "closed";
            while (!closing)
            {
                if (!Native.ReadFile(readHandle, buf, buf.Length, out int n, IntPtr.Zero))
                {
                    if (!closing) reason = "disconnected:" + Marshal.GetLastWin32Error();
                    break;
                }
                if (n <= 0) continue;
                var copy = new byte[n];
                Array.Copy(buf, copy, n);
                onReport(Id, copy);
            }
            onClosed(Id, reason);
        }

        public void Dispose()
        {
            closing = true;
            Native.CancelIoEx(readHandle, IntPtr.Zero);
            readHandle.Dispose();
            writeHandle.Dispose();
        }
    }
}
