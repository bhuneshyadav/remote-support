using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace RemoteSupportAgent;

internal sealed class ApiClient : IDisposable
{
    private readonly HttpClient _httpClient;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };

    public ApiClient()
    {
        var configuredUrl = Environment.GetEnvironmentVariable("REMOTE_SUPPORT_API_BASE_URL")
            ?? ReadConfiguredApiBaseUrl();
        if (!Uri.TryCreate(configuredUrl, UriKind.Absolute, out var baseUri)
            || (baseUri.Scheme != Uri.UriSchemeHttps && !IsLocalDevelopment(baseUri)))
        {
            throw new InvalidOperationException("The support service URL must use HTTPS.");
        }

        BaseUri = new Uri(baseUri, "/");
        _httpClient = new HttpClient { BaseAddress = BaseUri };
        _httpClient.Timeout = TimeSpan.FromSeconds(15);
    }

    public Uri BaseUri { get; }

    private static string ReadConfiguredApiBaseUrl()
    {
        var settingsPath = Path.Combine(AppContext.BaseDirectory, "appsettings.json");
        if (!File.Exists(settingsPath)) return "http://localhost:3001";

        try
        {
            using var settings = JsonDocument.Parse(File.ReadAllText(settingsPath));
            if (!settings.RootElement.TryGetProperty("RemoteSupportApiBaseUrl", out var value)
                || value.ValueKind != JsonValueKind.String)
            {
                throw new InvalidOperationException("RemoteSupportApiBaseUrl must be set in appsettings.json.");
            }
            var configuredUrl = value.GetString();
            if (string.IsNullOrWhiteSpace(configuredUrl))
            {
                throw new InvalidOperationException("RemoteSupportApiBaseUrl must be set in appsettings.json.");
            }
            return configuredUrl;
        }
        catch (JsonException error)
        {
            throw new InvalidOperationException("The agent's appsettings.json is invalid.", error);
        }
    }

    public Task<JoinResponse> JoinAsync(string code, CancellationToken cancellationToken) =>
        PostAsync<JoinResponse>(
            "api/v1/customer/sessions/join",
            new { code },
            cancellationToken);

    public Task<StatusResponse> DecideAsync(
        string decisionToken,
        string decision,
        CancellationToken cancellationToken) =>
        PostAsync<StatusResponse>(
            "api/v1/customer/sessions/decision",
            new { decisionToken, decision },
            cancellationToken);

    public Task<StatusResponse> GetStatusAsync(string customerToken, CancellationToken cancellationToken) =>
        PostAsync<StatusResponse>(
            "api/v1/customer/sessions/status",
            new { customerToken },
            cancellationToken);

    public Task<StatusResponse> EndAsync(string customerToken, CancellationToken cancellationToken) =>
        PostAsync<StatusResponse>(
            "api/v1/customer/sessions/end",
            new { customerToken },
            cancellationToken);

    private async Task<TResponse> PostAsync<TResponse>(
        string path,
        object request,
        CancellationToken cancellationToken)
    {
        using var response = await _httpClient.PostAsJsonAsync(path, request, JsonOptions, cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            throw new AgentApiException("The request is invalid, unavailable, or expired.");
        }

        if (!response.IsSuccessStatusCode)
        {
            throw new AgentApiException(response.StatusCode == HttpStatusCode.TooManyRequests
                ? "Too many attempts. Wait a few minutes and try again."
                : "The support service could not complete the request.");
        }

        try
        {
            return await response.Content.ReadFromJsonAsync<TResponse>(JsonOptions, cancellationToken)
                ?? throw new AgentApiException("The support service returned an empty response.");
        }
        catch (JsonException)
        {
            throw new AgentApiException("The support service returned an invalid response.");
        }
    }

    private static bool IsLocalDevelopment(Uri uri) =>
        uri.Scheme == Uri.UriSchemeHttp
        && (uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || IPAddress.TryParse(uri.Host, out var address) && IPAddress.IsLoopback(address));

    public void Dispose() => _httpClient.Dispose();
}

internal sealed class AgentApiException(string message) : Exception(message);

internal sealed record JoinResponse(
    string DecisionToken,
    string CustomerToken,
    string SessionId,
    JoinSession Session);

internal sealed record JoinSession(
    string Id,
    string Purpose,
    string OrganizationName,
    string TechnicianName,
    DateTimeOffset ExpiresAt,
    string Status);

internal sealed record StatusResponse(
    [property: JsonPropertyName("status")] string Status);
