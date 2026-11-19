using System;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class EdgeSyncHost
{
    private const string Origin = "chrome-extension://pjjhblfofncgibfbjnbgnpoaimpebeih/";
    private const int MaxBytes = 2 * 1024 * 1024;

    private static string Sync(byte[] request)
    {
        string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
        string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "YouDub2bi", "harness", "youdub");
        var info = new ProcessStartInfo {
            FileName = Path.Combine(profile, "runtime", "venv", "Scripts", "python.exe"),
            Arguments = "-I \"" + Path.Combine(root, "scripts", "edge-youtube-sync.py") + "\"",
            WorkingDirectory = root,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        using (var process = Process.Start(info)) {
            process.BeginErrorReadLine();
            using (var input = process.StandardInput.BaseStream) input.Write(request, 0, request.Length);
            if (!process.WaitForExit(15000)) {
                process.Kill();
                return "{\"ok\":false}";
            }
            var result = process.StandardOutput.ReadToEnd().Trim();
            return process.ExitCode == 0 && result == "{\"ok\":true}" ? result : "{\"ok\":false}";
        }
    }

    private static void Main(string[] args)
    {
        if (args.Length == 0 || (args[0] != Origin && args[0] + "/" != Origin)) return;
        string response = "{\"ok\":false}";
        try {
            using (var reader = new BinaryReader(Console.OpenStandardInput())) {
                uint size = reader.ReadUInt32();
                if (size > 0 && size <= MaxBytes) {
                    var body = reader.ReadBytes((int)size);
                    if (body.Length == size) response = Sync(body);
                }
            }
        } catch (Exception) {}
        using (var writer = new BinaryWriter(Console.OpenStandardOutput())) {
            byte[] body = Encoding.UTF8.GetBytes(response);
            writer.Write(body.Length);
            writer.Write(body);
        }
    }
}
