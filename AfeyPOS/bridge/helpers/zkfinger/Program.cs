// Afey POS fingerprint helper for ZKTeco readers, using the ZKFinger SDK (libzkfpcsharp).
// Speaks the bridge's JSON-lines protocol on stdin/stdout (see bridge/src/adapters/fingerprint.ts).
// Templates leave this process as base64; fingerprint images never do.
// NOT compiled or tested in the Afey POS build environment.
using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using libzkfpcsharp;

internal static class Program
{
    const int MatchThreshold = 50;       // ZKFinger's usual 1:1 threshold (scores run 0-100)
    const int CaptureTimeoutMs = 25000;  // the bridge waits a little longer than this

    static IntPtr device = IntPtr.Zero;
    static IntPtr db = IntPtr.Zero;
    static int width, height;
    static string model = "ZKTeco";

    static void Main()
    {
        Console.Out.Flush();
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            JsonNode req;
            try { req = JsonNode.Parse(line); } catch { continue; }
            var id = req?["id"]?.GetValue<int>() ?? 0;
            JsonObject reply;
            try { reply = Handle(req); }
            catch (Exception e) { reply = new JsonObject { ["ok"] = false, ["error"] = e.Message }; }
            reply["id"] = id;
            Console.WriteLine(reply.ToJsonString());
            Console.Out.Flush();
        }
        if (device != IntPtr.Zero) zkfp2.CloseDevice(device);
        if (db != IntPtr.Zero) zkfp2.DBFree(db);
        zkfp2.Terminate();
    }

    static void EnsureOpen()
    {
        if (device != IntPtr.Zero) return;
        int r = zkfp2.Init();
        if (r != zkfperrdef.ZKFP_ERR_OK && r != zkfperrdef.ZKFP_ERR_ALREADY_INIT) throw new Exception($"ZKFinger SDK init failed ({r})");
        if (zkfp2.GetDeviceCount() <= 0) throw new Exception("No ZKTeco fingerprint reader is connected");
        device = zkfp2.OpenDevice(0);
        if (device == IntPtr.Zero) throw new Exception("Could not open the fingerprint reader");
        db = zkfp2.DBInit();
        var buf = new byte[4];
        int size = 4;
        zkfp2.GetParameters(device, 1, buf, ref size); width = BitConverter.ToInt32(buf, 0);
        size = 4;
        zkfp2.GetParameters(device, 2, buf, ref size); height = BitConverter.ToInt32(buf, 0);
    }

    static JsonObject Handle(JsonNode req)
    {
        switch (req["cmd"]?.GetValue<string>())
        {
            case "status":
                try { EnsureOpen(); return new JsonObject { ["ok"] = true, ["connected"] = true, ["model"] = model, ["message"] = $"{width}x{height} sensor" }; }
                catch (Exception e) { return new JsonObject { ["ok"] = true, ["connected"] = false, ["message"] = e.Message }; }
            case "capture":
            {
                EnsureOpen();
                bool enroll = req["enroll"]?.GetValue<bool>() ?? false;
                byte[] tpl;
                if (enroll)
                {
                    // Three presses merged into one registration template, as the SDK recommends.
                    var presses = new List<byte[]>();
                    while (presses.Count < 3)
                    {
                        var t = CaptureOne();
                        if (presses.Count > 0 && zkfp2.DBMatch(db, presses[presses.Count - 1], t) <= 0) continue; // a different finger
                        presses.Add(t);
                    }
                    var merged = new byte[2048];
                    int len = merged.Length;
                    int r = zkfp2.DBMerge(db, presses[0], presses[1], presses[2], merged, ref len);
                    if (r != zkfperrdef.ZKFP_ERR_OK) throw new Exception($"Could not merge the three presses ({r}); try again");
                    tpl = new byte[len];
                    Array.Copy(merged, tpl, len);
                }
                else tpl = CaptureOne();
                return new JsonObject { ["ok"] = true, ["format"] = "zkfinger-v10", ["template"] = Convert.ToBase64String(tpl) };
            }
            case "match":
            {
                EnsureOpen();
                var cand = Convert.FromBase64String(req["candidate"]["template"].GetValue<string>());
                int best = 0;
                foreach (var s in req["stored"].AsArray()) best = Math.Max(best, zkfp2.DBMatch(db, cand, Convert.FromBase64String(s["template"].GetValue<string>())));
                return new JsonObject { ["ok"] = true, ["matched"] = best >= MatchThreshold, ["score"] = best };
            }
            case "identify":
            {
                EnsureOpen();
                var cand = Convert.FromBase64String(req["candidate"]["template"].GetValue<string>());
                int best = 0;
                string who = null;
                foreach (var s in req["stored"].AsArray())
                {
                    int score = zkfp2.DBMatch(db, cand, Convert.FromBase64String(s["template"].GetValue<string>()));
                    if (score > best) { best = score; who = s["userId"]?.GetValue<string>(); }
                }
                return new JsonObject { ["ok"] = true, ["userId"] = best >= MatchThreshold ? who : null, ["score"] = best };
            }
            default:
                return new JsonObject { ["ok"] = false, ["error"] = "Unknown command" };
        }
    }

    static byte[] CaptureOne()
    {
        var image = new byte[width * height];
        var tpl = new byte[2048];
        var until = DateTime.UtcNow.AddMilliseconds(CaptureTimeoutMs);
        while (DateTime.UtcNow < until)
        {
            int len = tpl.Length;
            if (zkfp2.AcquireFingerprint(device, image, tpl, ref len) == zkfperrdef.ZKFP_ERR_OK)
            {
                var t = new byte[len];
                Array.Copy(tpl, t, len);
                Array.Clear(image, 0, image.Length); // never keep the image
                return t;
            }
            Thread.Sleep(150);
        }
        throw new Exception("No finger detected; place your finger on the reader");
    }
}
