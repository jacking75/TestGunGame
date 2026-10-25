using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
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

namespace TestGunGame.Host
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            // --dev <url>: Vite 개발 서버를 연다. 없으면 실행 파일 옆 game 폴더(빌드 결과)를 연다.
            string devUrl = Environment.GetEnvironmentVariable("TGG_DEV_URL");
            for (int i = 0; i < args.Length - 1; i++) if (args[i] == "--dev") devUrl = args[i + 1];
            AppBuilder.Configure(() => new App(devUrl)).UsePlatformDetect().StartWithClassicDesktopLifetime(args);
        }
    }

    internal sealed class App : Application
    {
        private readonly string devUrl;

        public App(string devUrl)
        {
            this.devUrl = devUrl;
        }

        public override void Initialize() => Styles.Add(new FluentTheme());

        public override void OnFrameworkInitializationCompleted()
        {
            if (ApplicationLifetime is IClassicDesktopStyleApplicationLifetime desktop) desktop.MainWindow = new MainWindow(devUrl);
            base.OnFrameworkInitializationCompleted();
        }
    }

    /// <summary>게임 창. NativeWebView(WebView2)에 게임을 띄우고 HID·블루투스 기능을 메시지로 제공한다.</summary>
    internal sealed class MainWindow : Window
    {
        private const string VirtualHost = "game.local";
        private static readonly Color BackgroundColor = Color.FromRgb(20, 24, 29);
        private static readonly JsonSerializerOptions Json = new JsonSerializerOptions { IncludeFields = true };
        private readonly string devUrl;
        private readonly Dictionary<int, HidConnection> connections = new Dictionary<int, HidConnection>();
        private CoreWebView2 core;
        private int nextHandle = 1;
        private WiimotePairing pairing;
        private bool closed;

        public MainWindow(string devUrl)
        {
            this.devUrl = devUrl;
            Title = "TestGunGame";
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
                w.UserDataFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TestGunGame", "WebView2");
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
            // 게임 안의 전체 화면 요청은 WebView 영역만 채운다. 창을 테두리 없이 키워 작업 표시줄을 가리지 않는다.

            if (devUrl != null)
            {
                core.Navigate(devUrl);
            }
            else
            {
                string gameDir = Path.Combine(AppContext.BaseDirectory, "game");
                core.SetVirtualHostNameToFolderMapping(VirtualHost, gameDir, CoreWebView2HostResourceAccessKind.Allow);
                core.Navigate("https://" + VirtualHost + "/index.html");
            }
        }

        // ───── 게임 ↔ 호스트 메시지 ─────
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
            string cmd = msg.TryGetProperty("cmd", out JsonElement c) && c.ValueKind == JsonValueKind.String ? c.GetString() : null;
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

        private object Dispatch(string cmd, JsonElement msg, object id)
        {
            switch (cmd)
            {
                case "host.info":
                    return new Dictionary<string, object> { ["version"] = ProductVersion, ["canPair"] = true };

                case "hid.list":
                    return HidDevices.List();

                case "hid.open":
                {
                    string path = msg.GetProperty("path").GetString();
                    HidInfo info = HidDevices.List().Find(d => d.path == path) ?? throw new InvalidOperationException("장치가 없습니다");
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
                    HardwareLog.Append(msg.TryGetProperty("line", out JsonElement line) && line.ValueKind == JsonValueKind.String ? line.GetString() : null);
                    return true;

                default:
                    throw new InvalidOperationException("알 수 없는 명령: " + cmd);
            }
        }

        private static string ProductVersion =>
            Assembly.GetEntryAssembly()?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "";

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
