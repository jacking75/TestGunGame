# Bluetooth classic device list with pairing state (no admin needed).
# authenticated=1 means a link key exists (permanent pairing: the Wii remote reconnects with any button).
# remembered!=0 with authenticated=0 means Windows only remembers it; it cannot reconnect and should be removed.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\bt-status.ps1
$src = @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class BtStatus {
  [StructLayout(LayoutKind.Sequential)] public struct ST { public ushort y, mo, dow, d, h, mi, s, ms; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct DI {
    public int dwSize; public ulong Address; public uint cod; public int fConnected, fRemembered, fAuthenticated;
    public ST seen, used; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 248)] public string szName; }
  [StructLayout(LayoutKind.Sequential)] public struct SP { public int dwSize, fA, fR, fU, fC, fI; public byte t; public IntPtr hRadio; }
  [DllImport("bthprops.cpl")] static extern IntPtr BluetoothFindFirstDevice(ref SP p, ref DI d);
  [DllImport("bthprops.cpl")] static extern bool BluetoothFindNextDevice(IntPtr h, ref DI d);
  [DllImport("bthprops.cpl")] static extern bool BluetoothFindDeviceClose(IntPtr h);
  public static string List() {
    var sb = new StringBuilder();
    var p = new SP { dwSize = Marshal.SizeOf(typeof(SP)), fA = 1, fR = 1, fU = 1, fC = 1, fI = 0 };
    var d = new DI { dwSize = Marshal.SizeOf(typeof(DI)) };
    IntPtr h = BluetoothFindFirstDevice(ref p, ref d);
    if (h == IntPtr.Zero) return "no classic Bluetooth devices";
    do {
      byte[] b = BitConverter.GetBytes(d.Address);
      sb.AppendFormat("{0} {1:X2}:{2:X2}:{3:X2}:{4:X2}:{5:X2}:{6:X2} cod={7:X6} connected={8} remembered={9} authenticated={10}\n",
        d.szName, b[5], b[4], b[3], b[2], b[1], b[0], d.cod, d.fConnected, d.fRemembered, d.fAuthenticated);
      d = new DI { dwSize = Marshal.SizeOf(typeof(DI)) };
    } while (BluetoothFindNextDevice(h, ref d));
    BluetoothFindDeviceClose(h);
    return sb.ToString();
  }
}
'@
Add-Type -TypeDefinition $src
[BtStatus]::List()
