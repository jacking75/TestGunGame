using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.ApplicationLifetimes;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Platform;
using Avalonia.Themes.Fluent;
using Avalonia.Threading;
using Microsoft.Web.WebView2.Core;
using TestGunGame.Host;

namespace WiiHwTest
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            // --dev <url>: Vite 개발 서버를 연다. --sim: 리모컨 없이 마우스로 흐름을 확인한다(자동 검증용).
            string devUrl = null;
            bool sim = false;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--dev" && i + 1 < args.Length) devUrl = args[i + 1];
                if (args[i] == "--sim") sim = true;
            }
            AppBuilder.Configure(() => new App(devUrl, sim)).UsePlatformDetect().StartWithClassicDesktopLifetime(args);
        }
    }

    internal sealed class App : Application
    {
        private readonly string devUrl;
        private readonly bool sim;

        public App(string devUrl, bool sim)
        {
            this.devUrl = devUrl;
            this.sim = sim;
        }

        public override void Initialize() => Styles.Add(new FluentTheme());

        public override void OnFrameworkInitializationCompleted()
        {
            if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop) desktop.MainWindow = new MainWindow(devUrl, sim);
            base.OnFrameworkInitializationCompleted();
        }
    }

    /// <summary>
    /// 검증 앱 창. 게임과 같은 방식(WebView2 + HID·블루투스 메시지)이지만 데이터·기록 폴더는 따로 쓴다.
    /// 기록: %LOCALAPPDATA%\WiiHwTest\logs\hw-test.log, 결과: %LOCALAPPDATA%\WiiHwTest\results\*.json,
    /// 입력 녹화: %LOCALAPPDATA%\WiiHwTest\recordings\*.jsonl
    /// </summary>
    internal sealed class MainWindow : Window
    {
        private const string VirtualHost = "hwtest.local";
        private static readonly Color BackgroundColor = Color.FromRgb(16, 19, 24);
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
        private static readonly JsonSerializerOptions Json = new JsonSerializerOptions { IncludeFields = true };
        private readonly string devUrl;
        private readonly bool sim;
        private readonly string baseDir =
            Environment.GetEnvironmentVariable("WHT_DATA_DIR") is string d && d.Length > 0
                ? d
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WiiHwTest");
        private readonly Dictionary<int, HidConnection> connections = new Dictionary<int, HidConnection>();
        private CoreWebView2 core;
        private int nextHandle = 1;
        private WiimotePairing pairing;
        private int closedGame;
        private bool closed;
        /// <summary>이번 실행의 리모컨 입력 녹화 파일(게임 자동 검증에서 재생한다)</summary>
        private readonly string recordPath;

        public MainWindow(string devUrl, bool sim)
        {
            this.devUrl = devUrl;
            this.sim = sim;
            recordPath = Path.Combine(baseDir, "recordings", DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".jsonl");
            Title = "Wii 총 검증";
            Background = new SolidColorBrush(BackgroundColor);
            Width = 1280;
            Height = 720;
            // 작업 표시줄이 보이는 최대화 창. 전체 화면으로 바꾸지 않는다.
            WindowState = WindowState.Maximized;
            Closing += (s, e) =>
            {
                closed = true;
                pairing?.Cancel();
                foreach (var c in connections.Values) c.Dispose();
                connections.Clear();
            };

            // 리모컨은 한 프로그램만 쓸 수 있으므로 게임이 켜져 있으면 닫는다.
            if (!sim) closedGame = CloseGame();

            try
            {
                CoreWebView2Environment.GetAvailableBrowserVersionString();
            }
            catch (WebView2RuntimeNotFoundException)
            {
                ShowError("Microsoft Edge WebView2 런타임이 필요합니다.\nhttps://go.microsoft.com/fwlink/p/?LinkId=2124703 에서 설치한 뒤 다시 실행하세요.");
                return;
            }
            var web = new NativeWebView { Background = new SolidColorBrush(BackgroundColor) };
            web.EnvironmentRequested += OnEnvironmentRequested;
            web.AdapterCreated += OnAdapterCreated;
            Content = web;
        }

        private string LogDir => Path.Combine(baseDir, "logs");
        private string LogPath => Path.Combine(LogDir, "hw-test.log");

        private void ShowError(string message)
        {
            Content = new TextBlock
            {
                Text = message,
                Foreground = Brushes.White,
                FontSize = 18,
                TextWrapping = TextWrapping.Wrap,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
        }

        private void OnEnvironmentRequested(object sender, WebViewEnvironmentRequestedEventArgs e)
        {
            e.EnableDevTools = devUrl != null;
            if (e is WindowsWebView2EnvironmentRequestedEventArgs w)
            {
                w.UserDataFolder = Path.Combine(baseDir, "WebView2");
                w.AdditionalBrowserArguments = "--autoplay-policy=no-user-gesture-required";
            }
        }

        private void OnAdapterCreated(object sender, WebViewAdapterEventArgs e)
        {
            // Avalonia가 만든 WebView2를 받아 기존 WebView2 API(가상 호스트·JSON 메시지·설정)를 그대로 쓴다.
            if (e.TryGetPlatformHandle() is not IWindowsWebView2PlatformHandle handle)
            {
                ShowError("WebView2를 시작하지 못했습니다.");
                return;
            }
            core = CoreWebView2.CreateFromComICoreWebView2(handle.CoreWebView2);
            core.Settings.AreDevToolsEnabled = devUrl != null;
            core.Settings.AreDefaultContextMenusEnabled = devUrl != null;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.WebMessageReceived += OnMessage;

            string query = sim ? "?sim=1" : "";
            if (devUrl != null)
            {
                core.Navigate(devUrl + query);
            }
            else
            {
                string webDir = Path.Combine(AppContext.BaseDirectory, "web");
                core.SetVirtualHostNameToFolderMapping(VirtualHost, webDir, CoreWebView2HostResourceAccessKind.Allow);
                core.Navigate("https://" + VirtualHost + "/index.html" + query);
            }
        }

        private static int CloseGame()
        {
            int n = 0;
            foreach (Process p in Process.GetProcessesByName("TestGunGame"))
            {
                try
                {
                    if (!p.CloseMainWindow() || !p.WaitForExit(3000))
                    {
                        p.Kill();
                        p.WaitForExit(2000);
                    }
                    n++;
                }
                catch (Exception)
                {
                    // 이미 종료됨
                }
            }
            return n;
        }

        // ───── 화면 ↔ 앱 메시지 ─────
        // 요청: { id, cmd, ... } → 응답: { id, ok, result | error }
        // 알림: { event: "hid.report" | "hid.closed" | "bt.progress", ... }

        private void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            JsonElement msg;
            try
            {
                using var doc = JsonDocument.Parse(e.WebMessageAsJson);
                msg = doc.RootElement.Clone();
            }
            catch
            {
                return;
            }
            if (msg.ValueKind != JsonValueKind.Object) return;
            object id = msg.TryGetProperty("id", out JsonElement v) ? v : null;
            string cmd = Str(msg, "cmd");
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

        private static string Str(JsonElement msg, string key) =>
            msg.TryGetProperty(key, out JsonElement v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        private object Dispatch(string cmd, JsonElement msg, object id)
        {
            switch (cmd)
            {
                case "host.info":
                    return new Dictionary<string, object>
                    {
                        ["version"] = ProductVersion,
                        ["canPair"] = true,
                        ["closedGame"] = closedGame,
                        ["logPath"] = LogPath,
                        ["recordPath"] = recordPath,
                    };

                case "hid.list":
                    return HidDevices.List();

                case "hid.open":
                {
                    string path = msg.GetProperty("path").GetString();
                    HidInfo info = HidDevices.List().Find(x => x.path == path) ?? throw new InvalidOperationException("장치가 없습니다");
                    int handle = nextHandle++;
                    connections[handle] = new HidConnection(handle, info, OnReport, OnClosed);
                    return new Dictionary<string, object> { ["handle"] = handle, ["outputLength"] = info.outputLength, ["inputLength"] = info.inputLength };
                }

                case "hid.write":
                {
                    int handle = msg.GetProperty("handle").GetInt32();
                    if (!connections.TryGetValue(handle, out HidConnection conn)) throw new InvalidOperationException("닫힌 장치입니다");
                    byte reportId = msg.GetProperty("reportId").GetByte();
                    byte[] data = msg.GetProperty("data").EnumerateArray().Select(b => b.GetByte()).ToArray();
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
                    int handle = msg.GetProperty("handle").GetInt32();
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
                    int seconds = msg.TryGetProperty("seconds", out JsonElement s) ? s.GetInt32() : 120;
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
                    AppendLog(Str(msg, "line"));
                    return true;

                case "rec.append":
                {
                    string text = Str(msg, "text");
                    if (!string.IsNullOrEmpty(text))
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(recordPath));
                        File.AppendAllText(recordPath, text, Utf8);
                    }
                    return true;
                }

                case "result.save":
                {
                    string dir = Path.Combine(baseDir, "results");
                    Directory.CreateDirectory(dir);
                    string file = Path.Combine(dir, DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".json");
                    File.WriteAllText(file, Str(msg, "json") ?? "{}", Utf8);
                    return file;
                }

                default:
                    throw new InvalidOperationException("알 수 없는 명령: " + cmd);
            }
        }

        private static string ProductVersion =>
            Assembly.GetEntryAssembly()?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "";

        private void AppendLog(string line)
        {
            if (string.IsNullOrWhiteSpace(line)) return;
            Directory.CreateDirectory(LogDir);
            File.AppendAllText(LogPath, line.Trim().Replace("\r", " ").Replace("\n", " ") + "\n", Utf8);
        }

        private void OnReport(int handle, byte[] report)
        {
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
            if (core == null || closed) return;
            core.PostWebMessageAsJson(JsonSerializer.Serialize(message, Json));
        }

        private void Post(Action a)
        {
            if (closed) return;
            Dispatcher.UIThread.Post(() =>
            {
                // 창이 닫히는 중이면 버린다.
                if (!closed) a();
            });
        }
    }
}
