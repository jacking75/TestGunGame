using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace TestGunGame.Host
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            // --dev <url>: Vite 개발 서버를 연다. 없으면 실행 파일 옆 game 폴더(빌드 결과)를 연다.
            string devUrl = Environment.GetEnvironmentVariable("TGG_DEV_URL");
            for (int i = 0; i < args.Length - 1; i++) if (args[i] == "--dev") devUrl = args[i + 1];
            Application.Run(new MainForm(devUrl));
        }
    }

    /// <summary>게임 창. WebView2에 게임을 띄우고 HID·블루투스 기능을 메시지로 제공한다.</summary>
    internal sealed class MainForm : Form
    {
        private const string VirtualHost = "game.local";
        private readonly string devUrl;
        private readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(20, 24, 29) };
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        private readonly Dictionary<int, HidConnection> connections = new Dictionary<int, HidConnection>();
        private int nextHandle = 1;
        private WiimotePairing pairing;

        public MainForm(string devUrl)
        {
            this.devUrl = devUrl;
            Text = "TestGunGame";
            BackColor = Color.FromArgb(20, 24, 29);
            ClientSize = new Size(1280, 720);
            WindowState = FormWindowState.Maximized;
            Controls.Add(web);
            Load += async (s, e) => await InitAsync();
            FormClosing += (s, e) =>
            {
                pairing?.Cancel();
                foreach (var c in connections.Values) c.Dispose();
                connections.Clear();
            };
        }

        private async Task InitAsync()
        {
            string dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TestGunGame", "WebView2");
            var options = new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required");
            CoreWebView2Environment env;
            try
            {
                env = await CoreWebView2Environment.CreateAsync(null, dataDir, options);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                MessageBox.Show(this,
                    "Microsoft Edge WebView2 런타임이 필요합니다.\nhttps://go.microsoft.com/fwlink/p/?LinkId=2124703 에서 설치한 뒤 다시 실행하세요.",
                    "TestGunGame", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
                return;
            }
            await web.EnsureCoreWebView2Async(env);
            CoreWebView2 core = web.CoreWebView2;
            core.Settings.AreDevToolsEnabled = devUrl != null;
            core.Settings.AreDefaultContextMenusEnabled = devUrl != null;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.WebMessageReceived += OnMessage;
            // 게임 안의 전체 화면 요청은 WebView 영역만 채운다. 창을 테두리 없이 키워 작업 표시줄을 가리지 않는다.

            if (devUrl != null)
            {
                core.Navigate(devUrl);
            }
            else
            {
                string gameDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "game");
                core.SetVirtualHostNameToFolderMapping(VirtualHost, gameDir, CoreWebView2HostResourceAccessKind.Allow);
                core.Navigate("https://" + VirtualHost + "/index.html");
            }
        }

        // ───── 게임 ↔ 호스트 메시지 ─────
        // 요청: { id, cmd, ... } → 응답: { id, ok, result | error }
        // 알림: { event: "hid.report" | "hid.closed" | "bt.progress", ... }

        private void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            Dictionary<string, object> msg;
            try
            {
                msg = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
            }
            catch
            {
                return;
            }
            object id = msg.TryGetValue("id", out object v) ? v : null;
            string cmd = msg.TryGetValue("cmd", out object c) ? c as string : null;
            try
            {
                object result = Dispatch(cmd, msg, id);
                if (result != Pending) Reply(id, true, result, null);
            }
            catch (Exception ex)
            {
                Reply(id, false, null, ex.Message);
            }
        }

        private static readonly object Pending = new object();

        private object Dispatch(string cmd, Dictionary<string, object> msg, object id)
        {
            switch (cmd)
            {
                case "host.info":
                    return new Dictionary<string, object> { ["version"] = Application.ProductVersion, ["canPair"] = true };

                case "hid.list":
                    return HidDevices.List();

                case "hid.open":
                {
                    string path = (string)msg["path"];
                    HidInfo info = HidDevices.List().Find(d => d.path == path) ?? throw new InvalidOperationException("장치가 없습니다");
                    int handle = nextHandle++;
                    connections[handle] = new HidConnection(handle, info, OnReport, OnClosed);
                    return new Dictionary<string, object> { ["handle"] = handle, ["outputLength"] = info.outputLength, ["inputLength"] = info.inputLength };
                }

                case "hid.write":
                {
                    int handle = Convert.ToInt32(msg["handle"]);
                    if (!connections.TryGetValue(handle, out HidConnection conn)) throw new InvalidOperationException("닫힌 장치입니다");
                    byte reportId = Convert.ToByte(msg["reportId"]);
                    var list = (System.Collections.ArrayList)msg["data"];
                    var data = new byte[list.Count];
                    for (int i = 0; i < data.Length; i++) data[i] = Convert.ToByte(list[i]);
                    // 블루투스 쓰기는 수 ms 걸릴 수 있으므로 화면 스레드를 막지 않는다.
                    Task.Run(() =>
                    {
                        try
                        {
                            conn.Write(reportId, data);
                            Post(() => Reply(id, true, conn.WriteMethod, null));
                        }
                        catch (Exception ex)
                        {
                            Post(() => Reply(id, false, null, ex.Message));
                        }
                    });
                    return Pending;
                }

                case "hid.close":
                {
                    int handle = Convert.ToInt32(msg["handle"]);
                    if (connections.TryGetValue(handle, out HidConnection conn))
                    {
                        connections.Remove(handle);
                        conn.Dispose();
                    }
                    return true;
                }

                case "bt.pair":
                {
                    if (pairing != null) throw new InvalidOperationException("이미 등록을 진행 중입니다");
                    int seconds = msg.TryGetValue("seconds", out object s) ? Convert.ToInt32(s) : 120;
                    var p = new WiimotePairing(progress => Post(() => Send(new Dictionary<string, object>(progress) { ["event"] = "bt.progress" })));
                    pairing = p;
                    Task.Run(() =>
                    {
                        string r;
                        try
                        {
                            r = p.Run(seconds);
                        }
                        catch (Exception ex)
                        {
                            r = "error:" + ex.Message;
                        }
                        Post(() =>
                        {
                            pairing = null;
                            Reply(id, true, r, null);
                        });
                    });
                    return Pending;
                }

                case "bt.cancel":
                    pairing?.Cancel();
                    return true;

                case "log.append":
                    HardwareLog.Append(msg.TryGetValue("line", out object line) ? line as string : null);
                    return true;

                default:
                    throw new InvalidOperationException("알 수 없는 명령: " + cmd);
            }
        }

        private void OnReport(int handle, byte[] report)
        {
            // 보고서 번호는 첫 바이트, 나머지가 데이터
            var data = new int[report.Length - 1];
            for (int i = 1; i < report.Length; i++) data[i - 1] = report[i];
            Post(() => Send(new Dictionary<string, object> { ["event"] = "hid.report", ["handle"] = handle, ["reportId"] = report[0], ["data"] = data }));
        }

        private void OnClosed(int handle, string reason)
        {
            Post(() =>
            {
                if (connections.TryGetValue(handle, out HidConnection conn))
                {
                    connections.Remove(handle);
                    conn.Dispose();
                }
                Send(new Dictionary<string, object> { ["event"] = "hid.closed", ["handle"] = handle, ["reason"] = reason });
            });
        }

        private void Reply(object id, bool ok, object result, string error)
        {
            if (id == null) return;
            Send(new Dictionary<string, object> { ["id"] = id, ["ok"] = ok, ["result"] = result, ["error"] = error });
        }

        private void Send(object message)
        {
            if (web.CoreWebView2 == null || IsDisposed) return;
            web.CoreWebView2.PostWebMessageAsJson(json.Serialize(message));
        }

        private void Post(Action a)
        {
            if (IsDisposed || !IsHandleCreated) return;
            try
            {
                BeginInvoke(a);
            }
            catch (InvalidOperationException)
            {
                // 창이 닫히는 중
            }
        }
    }
}
