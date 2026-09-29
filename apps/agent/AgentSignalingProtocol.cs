using System.Text.Json;

namespace RemoteSupportAgent;

internal enum ServerSignalType
{
    Unknown,
    AuthOk,
    ParticipantConnected,
    Status,
    IceServers,
    Offer,
    Candidate,
    Error,
}

internal sealed record AgentIceServer(string[] Urls, string? Username, string? Credential);

internal sealed record ServerSignal(
    ServerSignalType Type,
    string? Role = null,
    bool ScreenViewingGranted = false,
    string? Status = null,
    string? Sdp = null,
    string? Candidate = null,
    string? SdpMid = null,
    ushort? SdpMLineIndex = null,
    string? UsernameFragment = null,
    string? Error = null,
    IReadOnlyList<AgentIceServer>? IceServers = null);

internal static class AgentSignalingProtocol
{
    public static string CreateAuth(string sessionId, string token) =>
        JsonSerializer.Serialize(new { type = "auth", sessionId, token });

    public static string CreateViewingGrant(bool granted) =>
        JsonSerializer.Serialize(new { type = "grant_viewing", granted });

    public static string CreateAnswer(string sdp) =>
        JsonSerializer.Serialize(new { type = "answer", payload = new { type = "answer", sdp } });

    public static string CreateCandidate(
        string candidate,
        string? sdpMid,
        ushort? sdpMLineIndex,
        string? usernameFragment) =>
        JsonSerializer.Serialize(new
        {
            type = "candidate",
            payload = new { candidate, sdpMid, sdpMLineIndex, usernameFragment },
        });

    public static bool TryParseServerMessage(string json, out ServerSignal signal)
    {
        signal = new ServerSignal(ServerSignalType.Unknown);
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("type", out var typeElement)
                || typeElement.ValueKind != JsonValueKind.String)
            {
                return false;
            }

            switch (typeElement.GetString())
            {
                case "auth_ok":
                    var granted = GetOptionalBoolean(root, "screenViewingGranted");
                    var role = GetString(root, "role");
                    if (granted is null || role is not ("customer" or "technician")) return false;
                    signal = new ServerSignal(
                        ServerSignalType.AuthOk,
                        Role: role,
                        ScreenViewingGranted: granted.Value);
                    return true;
                case "participant_connected":
                    signal = new ServerSignal(ServerSignalType.ParticipantConnected, Role: GetString(root, "role"));
                    return signal.Role is not null;
                case "status":
                    signal = new ServerSignal(ServerSignalType.Status, Status: GetString(root, "status"));
                    return signal.Status is not null;
                case "ice_servers":
                    if (!root.TryGetProperty("servers", out var serverArray)
                        || serverArray.ValueKind != JsonValueKind.Array
                        || serverArray.GetArrayLength() is < 1 or > 8)
                    {
                        return false;
                    }

                    var servers = new List<AgentIceServer>();
                    foreach (var item in serverArray.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.Object
                            || !item.TryGetProperty("urls", out var urlsElement))
                        {
                            return false;
                        }

                        var urls = urlsElement.ValueKind switch
                        {
                            JsonValueKind.String => new[] { urlsElement.GetString() },
                            JsonValueKind.Array => urlsElement.EnumerateArray()
                                .Select(url => url.ValueKind == JsonValueKind.String ? url.GetString() : null)
                                .ToArray(),
                            _ => [],
                        };
                        if (urls.Length is < 1 or > 8
                            || urls.Any(url => url is null || url.Length > 517
                                || !System.Text.RegularExpressions.Regex.IsMatch(url, @"^(stun|stuns|turn|turns):.{1,512}$", System.Text.RegularExpressions.RegexOptions.IgnoreCase)))
                        {
                            return false;
                        }

                        var username = GetString(item, "username");
                        var credential = GetString(item, "credential");
                        if (username?.Length > 512 || credential?.Length > 1024)
                        {
                            return false;
                        }
                        servers.Add(new AgentIceServer(urls!, username, credential));
                    }
                    signal = new ServerSignal(ServerSignalType.IceServers, IceServers: servers);
                    return true;
                case "offer":
                    if (!root.TryGetProperty("payload", out var offerPayload)
                        || GetString(offerPayload, "type") != "offer")
                    {
                        return false;
                    }
                    signal = new ServerSignal(ServerSignalType.Offer, Sdp: GetString(offerPayload, "sdp"));
                    return signal.Sdp is { Length: > 0 and <= 60_000 };
                case "candidate":
                    if (!root.TryGetProperty("payload", out var candidatePayload))
                    {
                        return false;
                    }
                    ushort? lineIndex = null;
                    if (candidatePayload.TryGetProperty("sdpMLineIndex", out var lineIndexElement)
                        && lineIndexElement.ValueKind == JsonValueKind.Number
                        && lineIndexElement.TryGetUInt16(out var parsedLineIndex))
                    {
                        if (parsedLineIndex > 1024) return false;
                        lineIndex = parsedLineIndex;
                    }
                    signal = new ServerSignal(
                        ServerSignalType.Candidate,
                        Candidate: GetString(candidatePayload, "candidate"),
                        SdpMid: GetString(candidatePayload, "sdpMid"),
                        SdpMLineIndex: lineIndex,
                        UsernameFragment: GetString(candidatePayload, "usernameFragment"));
                    return signal.Candidate is { Length: <= 4096 }
                        && signal.SdpMid is not { Length: > 256 }
                        && signal.UsernameFragment is not { Length: > 256 };
                case "error":
                    signal = new ServerSignal(ServerSignalType.Error, Error: GetString(root, "error"));
                    return true;
                default:
                    return false;
            }
        }
        catch (JsonException)
        {
            return false;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }

    private static string? GetString(JsonElement parent, string property) =>
        parent.ValueKind == JsonValueKind.Object
        && parent.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static bool? GetOptionalBoolean(JsonElement parent, string property)
    {
        if (parent.ValueKind != JsonValueKind.Object
            || !parent.TryGetProperty(property, out var value)
            || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
        {
            return null;
        }
        return value.GetBoolean();
    }
}
