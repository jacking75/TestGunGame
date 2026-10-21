using System;
using System.IO;
using System.Text;

namespace TestGunGame.Host
{
    /// <summary>
    /// 실물 확인 기록(hw-check.log). 리모컨 연결·센서바·버튼·게임 결과를 한 줄씩 남겨 지원·검증에 쓴다.
    /// 위치: %LOCALAPPDATA%\TestGunGame\logs (검증 스크립트는 TGG_LOG_DIR로 바꾼다). 5MB를 넘으면 이전 파일 하나만 남긴다.
    /// </summary>
    internal static class HardwareLog
    {
        private const long MaxBytes = 5 * 1024 * 1024;
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

        public static readonly string LogDir =
            Environment.GetEnvironmentVariable("TGG_LOG_DIR") is string dir && dir.Length > 0
                ? dir
                : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TestGunGame", "logs");

        public static string FilePath => Path.Combine(LogDir, "hw-check.log");

        public static void Append(string line)
        {
            if (string.IsNullOrWhiteSpace(line)) return;
            Directory.CreateDirectory(LogDir);
            var file = new FileInfo(FilePath);
            if (file.Exists && file.Length > MaxBytes)
            {
                string old = Path.Combine(LogDir, "hw-check.old.log");
                File.Delete(old);
                file.MoveTo(old);
            }
            File.AppendAllText(FilePath, line.Trim().Replace("\r", " ").Replace("\n", " ") + "\n", Utf8);
        }
    }
}
