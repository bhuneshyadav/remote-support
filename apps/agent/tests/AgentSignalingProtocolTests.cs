using System.Text.Json;
using Xunit;

namespace RemoteSupportAgent.Tests;

public sealed class AgentSignalingProtocolTests
{
    [Fact]
    public void AuthMessageCarriesSessionAndTokenOnlyInTheFirstMessagePayload()
    {
        using var message = JsonDocument.Parse(AgentSignalingProtocol.CreateAuth("session-id", "opaque-customer-token"));
        var root = message.RootElement;

        Assert.Equal("auth", root.GetProperty("type").GetString());
        Assert.Equal("session-id", root.GetProperty("sessionId").GetString());
        Assert.Equal("opaque-customer-token", root.GetProperty("token").GetString());
        Assert.Equal(3, root.EnumerateObject().Count());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void ConsentMessageUsesTheCustomerGrantShape(bool granted)
    {
        using var message = JsonDocument.Parse(AgentSignalingProtocol.CreateViewingGrant(granted));

        Assert.Equal("grant_viewing", message.RootElement.GetProperty("type").GetString());
        Assert.Equal(granted, message.RootElement.GetProperty("granted").GetBoolean());
    }

    [Fact]
    public void ParsesGrantedStatusAndAuthenticatedIceCredentials()
    {
        Assert.True(AgentSignalingProtocol.TryParseServerMessage(
            """{"type":"status","status":"viewing_granted"}""",
            out var status));
        Assert.Equal(ServerSignalType.Status, status.Type);
        Assert.Equal("viewing_granted", status.Status);

        Assert.True(AgentSignalingProtocol.TryParseServerMessage(
            """{"type":"ice_servers","servers":[{"urls":["turns:turn.example.test"],"username":"temporary-user","credential":"temporary-secret"}]}""",
            out var ice));
        Assert.Equal(ServerSignalType.IceServers, ice.Type);
        Assert.Equal("turns:turn.example.test", Assert.Single(Assert.Single(ice.IceServers!).Urls));
        Assert.Equal("temporary-user", ice.IceServers[0].Username);
        Assert.Equal("temporary-secret", ice.IceServers[0].Credential);
    }

    [Fact]
    public void RejectsInvalidServerPayloads()
    {
        Assert.False(AgentSignalingProtocol.TryParseServerMessage(
            """{"type":"auth_ok","role":"customer"}""",
            out _));
        Assert.False(AgentSignalingProtocol.TryParseServerMessage(
            """{"type":"ice_servers","servers":[{"urls":"https://invalid.example.test"}]}""",
            out _));
    }
}
