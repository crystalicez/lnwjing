using System.Runtime.InteropServices.WindowsRuntime;
using System.Text.Json;
using Windows.ApplicationModel;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

namespace Lnwjing.WindowsOcr;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    private static async Task Main()
    {
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            object response;
            try
            {
                using var document = JsonDocument.Parse(line);
                response = await RecognizeAsync(document.RootElement);
            }
            catch (Exception exception)
            {
                response = Failure("INTERNAL_ERROR", "Windows OCR helper failed: " + exception.GetType().Name, true);
            }

            Console.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
            Console.Out.Flush();
        }
    }

    private static async Task<object> RecognizeAsync(JsonElement input)
    {
        if (input.ValueKind == JsonValueKind.Object && input.TryGetProperty("op", out var opElement)
            && opElement.ValueKind == JsonValueKind.String && opElement.GetString() == "probe")
        {
            var identity = HasPackageIdentity();
            object payload = identity
                ? new { available = true, ready = true, backend = "Windows.Media.Ocr", package_identity = true }
                : new { available = false, ready = false, backend = "Windows.Media.Ocr", package_identity = false, reason = "package_identity_required" };
            return Success(payload);
        }

        if (!HasPackageIdentity())
        {
            return Success(new
            {
                available = false,
                ready = false,
                backend = "Windows.Media.Ocr",
                reason = "package_identity_required",
            });
        }

        if (!input.TryGetProperty("image_base64", out var encodedElement) || encodedElement.ValueKind != JsonValueKind.String)
        {
            return Failure("INVALID_INPUT", "image_base64 is required for Windows OCR", false);
        }

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(encodedElement.GetString() ?? string.Empty);
        }
        catch (FormatException)
        {
            return Failure("INVALID_INPUT", "image_base64 is invalid", false);
        }

        if (bytes.Length == 0 || bytes.Length > 16 * 1024 * 1024)
        {
            return Failure("FILE_TOO_LARGE", "OCR image must be between 1 byte and 16 MiB", false);
        }

        using var stream = new InMemoryRandomAccessStream();
        await stream.WriteAsync(bytes.AsBuffer());
        stream.Seek(0);
        var decoder = await BitmapDecoder.CreateAsync(stream);
        using var bitmap = await decoder.GetSoftwareBitmapAsync();
        var engine = OcrEngine.TryCreateFromUserProfileLanguages();
        if (engine is null)
        {
            return Success(new
            {
                available = false,
                ready = false,
                backend = "Windows.Media.Ocr",
                reason = "no_supported_user_profile_language",
            });
        }

        var result = await engine.RecognizeAsync(bitmap);
        var lines = result.Lines.Select((line, index) => new
        {
            lineIndex = index,
            text = line.Text,
            words = line.Words.Select(word => new { text = word.Text }).ToArray(),
        }).ToArray();
        return Success(new
        {
            available = true,
            ready = true,
            backend = "Windows.Media.Ocr",
            text = result.Text,
            lines,
        });
    }

    private static bool HasPackageIdentity()
    {
        try
        {
            return !string.IsNullOrWhiteSpace(Package.Current.Id.Name);
        }
        catch
        {
            return false;
        }
    }

    private static object Success(object value) => new { ok = true, value };

    private static object Failure(string code, string message, bool recoverable) => new
    {
        ok = false,
        error = new { code, message, recoverable },
    };
}
