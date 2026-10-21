using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace TestGunGame.Host
{
    /// <summary>Windows HID·블루투스 API 선언</summary>
    internal static class Native
    {
        // ───── SetupAPI: HID 장치 목록 ─────
        public const int DIGCF_PRESENT = 0x02;
        public const int DIGCF_DEVICEINTERFACE = 0x10;

        [StructLayout(LayoutKind.Sequential)]
        public struct SP_DEVICE_INTERFACE_DATA
        {
            public int cbSize;
            public Guid InterfaceClassGuid;
            public int Flags;
            public IntPtr Reserved;
        }

        [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr SetupDiGetClassDevs(ref Guid classGuid, IntPtr enumerator, IntPtr hwndParent, int flags);

        [DllImport("setupapi.dll", SetLastError = true)]
        public static extern bool SetupDiEnumDeviceInterfaces(IntPtr deviceInfoSet, IntPtr deviceInfoData, ref Guid interfaceClassGuid, int memberIndex, ref SP_DEVICE_INTERFACE_DATA deviceInterfaceData);

        [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr deviceInfoSet, ref SP_DEVICE_INTERFACE_DATA deviceInterfaceData, IntPtr detail, int detailSize, out int requiredSize, IntPtr deviceInfoData);

        [DllImport("setupapi.dll", SetLastError = true)]
        public static extern bool SetupDiDestroyDeviceInfoList(IntPtr deviceInfoSet);

        // ───── kernel32 ─────
        public const uint GENERIC_READ = 0x80000000;
        public const uint GENERIC_WRITE = 0x40000000;
        public const uint FILE_SHARE_READ = 0x1;
        public const uint FILE_SHARE_WRITE = 0x2;
        public const uint OPEN_EXISTING = 3;

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern SafeFileHandle CreateFile(string fileName, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool ReadFile(SafeFileHandle h, byte[] buffer, int toRead, out int read, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool WriteFile(SafeFileHandle h, byte[] buffer, int toWrite, out int written, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CancelIoEx(SafeFileHandle h, IntPtr overlapped);

        [DllImport("kernel32.dll")]
        public static extern bool CloseHandle(IntPtr h);

        // ───── hid.dll ─────
        [StructLayout(LayoutKind.Sequential)]
        public struct HIDD_ATTRIBUTES
        {
            public int Size;
            public ushort VendorID;
            public ushort ProductID;
            public ushort VersionNumber;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct HIDP_CAPS
        {
            public ushort Usage;
            public ushort UsagePage;
            public ushort InputReportByteLength;
            public ushort OutputReportByteLength;
            public ushort FeatureReportByteLength;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
            public ushort NumberLinkCollectionNodes;
            public ushort NumberInputButtonCaps;
            public ushort NumberInputValueCaps;
            public ushort NumberInputDataIndices;
            public ushort NumberOutputButtonCaps;
            public ushort NumberOutputValueCaps;
            public ushort NumberOutputDataIndices;
            public ushort NumberFeatureButtonCaps;
            public ushort NumberFeatureValueCaps;
            public ushort NumberFeatureDataIndices;
        }

        [DllImport("hid.dll")]
        public static extern void HidD_GetHidGuid(out Guid hidGuid);

        [DllImport("hid.dll", SetLastError = true)]
        public static extern bool HidD_GetAttributes(SafeFileHandle h, ref HIDD_ATTRIBUTES attributes);

        [DllImport("hid.dll", SetLastError = true)]
        public static extern bool HidD_GetProductString(SafeFileHandle h, byte[] buffer, int length);

        [DllImport("hid.dll", SetLastError = true)]
        public static extern bool HidD_GetPreparsedData(SafeFileHandle h, out IntPtr preparsed);

        [DllImport("hid.dll", SetLastError = true)]
        public static extern bool HidD_FreePreparsedData(IntPtr preparsed);

        [DllImport("hid.dll", SetLastError = true)]
        public static extern int HidP_GetCaps(IntPtr preparsed, out HIDP_CAPS caps);

        [DllImport("hid.dll", SetLastError = true)]
        public static extern bool HidD_SetOutputReport(SafeFileHandle h, byte[] buffer, int length);

        // ───── bthprops: 블루투스 등록 ─────
        [StructLayout(LayoutKind.Sequential)]
        public struct BLUETOOTH_FIND_RADIO_PARAMS { public int dwSize; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct BLUETOOTH_RADIO_INFO
        {
            public int dwSize;
            public ulong address;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 248)] public string szName;
            public uint ulClassofDevice;
            public ushort lmpSubversion;
            public ushort manufacturer;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct BLUETOOTH_DEVICE_SEARCH_PARAMS
        {
            public int dwSize;
            public int fReturnAuthenticated;
            public int fReturnRemembered;
            public int fReturnUnknown;
            public int fReturnConnected;
            public int fIssueInquiry;
            public byte cTimeoutMultiplier;
            public IntPtr hRadio;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct SYSTEMTIME { public ushort y, mo, dow, d, h, mi, s, ms; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct BLUETOOTH_DEVICE_INFO
        {
            public int dwSize;
            public ulong Address;
            public uint ulClassofDevice;
            public int fConnected;
            public int fRemembered;
            public int fAuthenticated;
            public SYSTEMTIME stLastSeen;
            public SYSTEMTIME stLastUsed;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 248)] public string szName;
        }

        [DllImport("bthprops.cpl", SetLastError = true)]
        public static extern IntPtr BluetoothFindFirstRadio(ref BLUETOOTH_FIND_RADIO_PARAMS p, out IntPtr hRadio);

        [DllImport("bthprops.cpl", SetLastError = true)]
        public static extern bool BluetoothFindRadioClose(IntPtr hFind);

        [DllImport("bthprops.cpl", SetLastError = true)]
        public static extern int BluetoothGetRadioInfo(IntPtr hRadio, ref BLUETOOTH_RADIO_INFO info);

        [DllImport("bthprops.cpl", SetLastError = true)]
        public static extern IntPtr BluetoothFindFirstDevice(ref BLUETOOTH_DEVICE_SEARCH_PARAMS p, ref BLUETOOTH_DEVICE_INFO info);

        [DllImport("bthprops.cpl", SetLastError = true)]
        public static extern bool BluetoothFindNextDevice(IntPtr hFind, ref BLUETOOTH_DEVICE_INFO info);

        [DllImport("bthprops.cpl", SetLastError = true)]
        public static extern bool BluetoothFindDeviceClose(IntPtr hFind);

        [DllImport("bthprops.cpl", SetLastError = true)]
        public static extern int BluetoothRemoveDevice(ref ulong address);

        // 등록(인증): 콜백 방식만 PIN을 원본 바이트로 보낼 수 있다(Wii 리모컨 PIN에는 0x00·0x80 이상 값이 들어간다).
        // 구버전 BluetoothAuthenticateDevice(WCHAR PIN)는 이 PC 주소(17 00 9C 4A 55 8C)에서 매번 31로 실패했고,
        // 실패하면 Windows가 리모컨 연결을 끊어 검색 상태가 풀린다(2026-10-22 기록). 쓰지 않는다.
        public const int BLUETOOTH_AUTHENTICATION_METHOD_LEGACY = 1;
        public const int MITMProtectionNotRequired = 0;

        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        public delegate bool AuthenticationCallbackEx(IntPtr param, IntPtr callbackParams);

        [DllImport("bthprops.cpl", SetLastError = true)]
        public static extern int BluetoothRegisterForAuthenticationEx(ref BLUETOOTH_DEVICE_INFO device, out IntPtr registration, AuthenticationCallbackEx callback, IntPtr param);

        [DllImport("bthprops.cpl", SetLastError = true)]
        public static extern bool BluetoothUnregisterAuthentication(IntPtr registration);

        [DllImport("bthprops.cpl", SetLastError = true)]
        public static extern int BluetoothSendAuthenticationResponseEx(IntPtr hRadio, IntPtr response);

        [DllImport("bthprops.cpl", SetLastError = true)]
        public static extern int BluetoothAuthenticateDeviceEx(IntPtr hwnd, IntPtr hRadio, ref BLUETOOTH_DEVICE_INFO device, IntPtr oobData, int authenticationRequirement);

        [DllImport("bthprops.cpl", SetLastError = true)]
        public static extern int BluetoothGetDeviceInfo(IntPtr hRadio, ref BLUETOOTH_DEVICE_INFO device);

        /// <summary>
        /// BLUETOOTH_AUTHENTICATE_RESPONSE(48바이트): 주소 @0 · 방식 @8 · PIN @12(16) · PIN 길이 @28 · 거절 @44.
        /// Windows SDK 10.0.26100 헤더로 컴파일해 확인한 배치다. 레거시 PIN 응답만 만든다.
        /// </summary>
        public static IntPtr BuildPinResponse(ulong remote, byte[] pin)
        {
            IntPtr p = Marshal.AllocHGlobal(48);
            for (int i = 0; i < 48; i++) Marshal.WriteByte(p, i, 0);
            Marshal.WriteInt64(p, 0, (long)remote);
            Marshal.WriteInt32(p, 8, BLUETOOTH_AUTHENTICATION_METHOD_LEGACY);
            for (int i = 0; i < pin.Length && i < 16; i++) Marshal.WriteByte(p, 12 + i, pin[i]);
            Marshal.WriteByte(p, 28, (byte)pin.Length);
            return p;
        }

        /// <summary>인증 직후 호출해야 리모컨이 등록을 기억한다. 서비스 목록 버퍼 없이 개수만 묻는다(ERROR_MORE_DATA도 정상).</summary>
        [DllImport("bthprops.cpl", SetLastError = true)]
        public static extern int BluetoothEnumerateInstalledServices(IntPtr hRadio, ref BLUETOOTH_DEVICE_INFO info, ref int serviceCount, IntPtr services);

        [DllImport("bthprops.cpl", SetLastError = true)]
        public static extern int BluetoothSetServiceState(IntPtr hRadio, ref BLUETOOTH_DEVICE_INFO info, ref Guid service, int flags);

        public static readonly Guid HidServiceClass = new Guid("00001124-0000-1000-8000-00805F9B34FB");
    }
}
