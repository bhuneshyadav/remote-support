using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using SIPSorcery.Media;
using SIPSorcery.Net;
using SIPSorceryMedia.Abstractions;
using Vpx.Net;

namespace RemoteSupportAgent;

internal sealed class ScreenPublisher : IAsyncDisposable
{
    private const int VideoWidth = 640;
    private const int VideoHeight = 360;
    private const uint VideoRtpDuration = 9000;

    private readonly Uri _apiBaseUri;
    private readonly string _sessionId;
    private readonly string _customerToken;
    private readonly Action<string> _statusChanged;
    private readonly Action<string> _stopped;
    private readonly ClientWebSocket _socket = new();
    private readonly CancellationTokenSource _shutdown = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly TaskCompletionSource<bool> _authenticated = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource<bool> _stoppedCompletion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly List<RTCIceCandidateInit> _pendingRemoteCandidates = [];
    private readonly List<(string Candidate, string? SdpMid, ushort? SdpMLineIndex, string? UsernameFragment)> _pendingLocalCandidates = [];
    private Task? _receiveTask;
    private Task? _captureTask;
    private RTCPeerConnection? _peer;
    private VP8Codec? _encoder;
    private DesktopCapture? _capture;
    private CaptureIndicator? _indicator;
    private IReadOnlyList<AgentIceServer>? _iceServers;
    private string? _pendingOffer;
    private bool _viewingGranted;
    private bool _grantSent;
    private bool _answerSent;
    private bool _stoppedFlag;
    private readonly object _stateLock = new();

    public ScreenPublisher(
        Uri apiBaseUri,
        string sessionId,
        string customerToken,
        Action<string> statusChanged,
        Action<string> stopped)
    {
        _apiBaseUri = apiBaseUri;
        _sessionId = sessionId;
        _customerToken = customerToken;
        _statusChanged = statusChanged;
        _stopped = stopped;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            var signalingUri = GetSignalingUri(_apiBaseUri);
            await _socket.ConnectAsync(signalingUri, cancellationToken);

            // No signaling message, including ICE or consent, may precede this auth message.
            await SendJsonAsync(AgentSignalingProtocol.CreateAuth(_sessionId, _customerToken), cancellationToken);
            _receiveTask = ReceiveLoopAsync(_shutdown.Token);
            await _authenticated.Task.WaitAsync(TimeSpan.FromSeconds(15), cancellationToken);

            if (Volatile.Read(ref _stoppedFlag))
            {
                throw new InvalidOperationException("The support session ended before screen sharing could start.");
            }

            _grantSent = true;
            await SendJsonAsync(AgentSignalingProtocol.CreateViewingGrant(true), cancellationToken);
            _statusChanged("You chose to share your screen. Waiting for the technician and secure connection settings.");
            await StartPublisherIfReadyAsync(_shutdown.Token);
        }
        catch (TimeoutException)
        {
            await StopAsync();
            throw new InvalidOperationException("The support service did not authenticate the screen-sharing session.");
        }
        catch
        {
            await StopAsync();
            throw;
        }
    }

    public async Task StopAsync()
    {
        if (Interlocked.Exchange(ref _stoppedFlag, true))
        {
            await _stoppedCompletion.Task;
            return;
        }

        try
        {
            _authenticated.TrySetException(new InvalidOperationException("Screen sharing stopped."));
            if (_grantSent && _socket.State == WebSocketState.Open)
            {
                try
                {
                    await SendJsonAsync(AgentSignalingProtocol.CreateViewingGrant(false), CancellationToken.None);
                }
                catch (WebSocketException)
                {
                }
                catch (OperationCanceledException)
                {
                }
            }

            _shutdown.Cancel();
            await StopMediaAsync();
            if (_socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                try
                {
                    await _socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "screen sharing stopped", CancellationToken.None);
                }
                catch (WebSocketException)
                {
                }
            }
        }
        finally
        {
            _stoppedCompletion.TrySetResult(true);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        _socket.Dispose();
        _sendLock.Dispose();
        _shutdown.Dispose();
    }

    private async Task ReceiveLoopAsync(CancellationToken cancellationToken)
    {
        var buffer = new byte[8192];
        using var message = new MemoryStream();
        try
        {
            while (!cancellationToken.IsCancellationRequested && _socket.State == WebSocketState.Open)
            {
                message.SetLength(0);
                WebSocketReceiveResult result;
                do
                {
                    result = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        await StopForServerAsync("The secure signaling connection was closed.");
                        return;
                    }
                    if (result.MessageType != WebSocketMessageType.Text || message.Length + result.Count > 128 * 1024)
                    {
                        await StopForServerAsync("The signaling service sent an unsupported message.");
                        return;
                    }
                    message.Write(buffer, 0, result.Count);
                }
                while (!result.EndOfMessage);

                var json = Encoding.UTF8.GetString(message.GetBuffer(), 0, checked((int)message.Length));
                if (!AgentSignalingProtocol.TryParseServerMessage(json, out var signal))
                {
                    await StopForServerAsync("The signaling service sent an invalid message.");
                    return;
                }

                switch (signal.Type)
                {
                    case ServerSignalType.AuthOk:
                        if (!string.Equals(signal.Role, "customer", StringComparison.Ordinal))
                        {
                            _authenticated.TrySetException(new InvalidOperationException("The signaling session is not authenticated as a customer."));
                            await StopForServerAsync("Could not authenticate as the customer.");
                            return;
                        }
                        _authenticated.TrySetResult(true);
                        if (signal.ScreenViewingGranted) _viewingGranted = true;
                        break;
                    case ServerSignalType.Status:
                        if (signal.Status == "viewing_granted")
                        {
                            _viewingGranted = true;
                            _statusChanged("Screen viewing is approved. Waiting for the technician to connect.");
                            await StartPublisherIfReadyAsync(cancellationToken);
                        }
                        else if (signal.Status == "viewing_revoked")
                        {
                            await StopForServerAsync("The customer or technician stopped screen viewing.");
                            return;
                        }
                        else if (signal.Status is "ended" or "expired")
                        {
                            await StopForServerAsync(signal.Status == "ended"
                                ? "The support session has ended."
                                : "The support session has expired.");
                            return;
                        }
                        break;
                    case ServerSignalType.IceServers:
                        if (_grantSent && signal.IceServers is not null)
                        {
                            // ICE credentials are only emitted by the server once consent is persisted.
                            _viewingGranted = true;
                            _iceServers = signal.IceServers;
                            _statusChanged("Screen viewing is approved and secure connection settings are ready. Waiting for the technician's offer.");
                            await StartPublisherIfReadyAsync(cancellationToken);
                        }
                        break;
                    case ServerSignalType.Offer:
                        if (_grantSent && signal.Sdp is not null)
                        {
                            _pendingOffer = signal.Sdp;
                            await StartPublisherIfReadyAsync(cancellationToken);
                        }
                        break;
                    case ServerSignalType.Candidate:
                        if (signal.Candidate is not null)
                        {
                            var candidate = new RTCIceCandidateInit
                            {
                                candidate = signal.Candidate,
                                sdpMid = signal.SdpMid,
                                sdpMLineIndex = signal.SdpMLineIndex ?? 0,
                                usernameFragment = signal.UsernameFragment,
                            };
                            if (_peer?.remoteDescription is null) _pendingRemoteCandidates.Add(candidate);
                            else _peer.addIceCandidate(candidate);
                        }
                        break;
                    case ServerSignalType.Error:
                        await StopForServerAsync(
                            string.IsNullOrWhiteSpace(signal.Error)
                                ? "The signaling service could not start screen viewing."
                                : $"The signaling service could not start screen viewing: {signal.Error}");
                        return;
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (WebSocketException)
        {
            await StopForServerAsync("The secure signaling connection was lost.");
        }
        catch (Exception error)
        {
            System.Diagnostics.Trace.TraceWarning("Screen publisher stopped after signaling error: {0}", error.GetType().Name);
            await StopForServerAsync("Could not establish the screen-sharing connection.");
        }
    }

    private async Task StartPublisherIfReadyAsync(CancellationToken cancellationToken)
    {
        if (!_grantSent || !_viewingGranted || _iceServers is null || _pendingOffer is null || _peer is not null)
        {
            return;
        }

        var peer = new RTCPeerConnection(new RTCConfiguration
        {
            iceServers = _iceServers
                .SelectMany(server => server.Urls.Select(url => new RTCIceServer
                {
                    urls = url,
                    username = server.Username ?? "",
                    credential = server.Credential ?? "",
                }))
                .ToList(),
        });
        _peer = peer;
        peer.addTrack(new MediaStreamTrack(
            new VideoFormat(VideoCodecsEnum.VP8, 96),
            MediaStreamStatusEnum.SendOnly));
        peer.onicecandidate += candidate =>
        {
            if (candidate is null) return;
            var localCandidate = (candidate.candidate, candidate.sdpMid, candidate.sdpMLineIndex, candidate.usernameFragment);
            lock (_stateLock)
            {
                if (!_answerSent)
                {
                    _pendingLocalCandidates.Add(localCandidate);
                    return;
                }
            }
            _ = SendCandidateSafelyAsync(localCandidate);
        };
        peer.onconnectionstatechange += state =>
        {
            if (state == RTCPeerConnectionState.connected)
            {
                _statusChanged("Screen sharing is active. Use the visible red banner or Stop sharing to stop.");
            }
            else if (state == RTCPeerConnectionState.failed)
            {
                _ = StopForServerAsync("The screen connection failed.");
            }
        };

        var indicatorDispatcher = System.Windows.Application.Current.Dispatcher;
        await indicatorDispatcher.InvokeAsync(() =>
        {
            _indicator = new CaptureIndicator(() => _ = StopForServerAsync("Screen sharing stopped by the customer."));
        });

        try
        {
            _capture = new DesktopCapture();
            _encoder = new VP8Codec();
        }
        catch
        {
            await StopForServerAsync("Could not access the visible Windows desktop for screen capture.");
            return;
        }

        var remoteResult = peer.setRemoteDescription(new RTCSessionDescriptionInit
        {
            type = RTCSdpType.offer,
            sdp = _pendingOffer,
        });
        if (remoteResult != SetDescriptionResultEnum.OK)
        {
            await StopForServerAsync("The technician's screen-viewing offer could not be applied.");
            return;
        }

        foreach (var candidate in _pendingRemoteCandidates)
        {
            peer.addIceCandidate(candidate);
        }
        _pendingRemoteCandidates.Clear();

        var answer = peer.createAnswer(null);
        await peer.setLocalDescription(answer);
        await SendJsonAsync(AgentSignalingProtocol.CreateAnswer(peer.localDescription.sdp.ToString()), cancellationToken);
        List<(string Candidate, string? SdpMid, ushort? SdpMLineIndex, string? UsernameFragment)> queuedCandidates;
        lock (_stateLock)
        {
            _answerSent = true;
            queuedCandidates = [.. _pendingLocalCandidates];
            _pendingLocalCandidates.Clear();
        }
        foreach (var candidate in queuedCandidates)
        {
            await SendCandidateSafelyAsync(candidate);
        }

        _captureTask = Task.Run(() => CaptureLoopAsync(peer, cancellationToken), cancellationToken);
        _statusChanged("Screen sharing has started. A visible red indicator is displayed on your desktop.");
    }

    private async Task CaptureLoopAsync(RTCPeerConnection peer, CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested
                && !Volatile.Read(ref _stoppedFlag)
                && peer.connectionState is not RTCPeerConnectionState.closed and not RTCPeerConnectionState.failed)
            {
                var rawFrame = _capture?.CaptureBgrFrame();
                var encoded = rawFrame is null
                    ? null
                    : _encoder?.EncodeVideo(
                        VideoWidth,
                        VideoHeight,
                        rawFrame,
                        VideoPixelFormatsEnum.Bgr,
                        VideoCodecsEnum.VP8);
                if (encoded is { Length: > 0 } && peer.connectionState == RTCPeerConnectionState.connected)
                {
                    peer.SendVideo(VideoRtpDuration, encoded);
                }
                await Task.Delay(TimeSpan.FromMilliseconds(100), cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            System.Diagnostics.Trace.TraceWarning("Screen capture stopped after error: {0}", error.GetType().Name);
            _ = StopForServerAsync("Screen capture stopped because the desktop is no longer available.");
        }
    }

    private async Task SendCandidateSafelyAsync(
        (string Candidate, string? SdpMid, ushort? SdpMLineIndex, string? UsernameFragment) candidate)
    {
        try
        {
            await SendJsonAsync(
                AgentSignalingProtocol.CreateCandidate(
                    candidate.Candidate,
                    candidate.SdpMid,
                    candidate.SdpMLineIndex,
                    candidate.UsernameFragment),
                _shutdown.Token);
        }
        catch (OperationCanceledException)
        {
        }
        catch (WebSocketException)
        {
            await StopForServerAsync("The secure signaling connection was lost.");
        }
    }

    private async Task SendJsonAsync(string json, CancellationToken cancellationToken)
    {
        await _sendLock.WaitAsync(cancellationToken);
        try
        {
            if (_socket.State != WebSocketState.Open)
            {
                throw new WebSocketException("Signaling socket is not open.");
            }
            var bytes = Encoding.UTF8.GetBytes(json);
            await _socket.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, cancellationToken);
        }
        finally
        {
            _sendLock.Release();
        }
    }

    private async Task StopForServerAsync(string reason)
    {
        var wasStopped = Volatile.Read(ref _stoppedFlag);
        _authenticated.TrySetException(new InvalidOperationException(reason));
        await StopAsync();
        if (!wasStopped) _stopped(reason);
    }

    private async Task StopMediaAsync()
    {
        _shutdown.Cancel();
        var peer = _peer;
        _peer = null;
        peer?.Close("screen sharing stopped");
        if (_captureTask is not null)
        {
            try
            {
                await _captureTask;
            }
            catch (OperationCanceledException)
            {
            }
            catch (AggregateException)
            {
            }
        }
        _capture?.Dispose();
        _capture = null;
        if (_encoder is IDisposable disposableEncoder) disposableEncoder.Dispose();
        _encoder = null;

        var dispatcher = System.Windows.Application.Current?.Dispatcher;
        if (dispatcher is not null && !dispatcher.HasShutdownStarted)
        {
            await dispatcher.InvokeAsync(() =>
            {
                _indicator?.Dispose();
                _indicator = null;
            });
        }
    }

    private static Uri GetSignalingUri(Uri apiBaseUri)
    {
        if (apiBaseUri.Scheme is not ("http" or "https"))
        {
            throw new InvalidOperationException("The support service URL must use HTTP or HTTPS.");
        }

        var builder = new UriBuilder(apiBaseUri)
        {
            Scheme = apiBaseUri.Scheme == Uri.UriSchemeHttps ? "wss" : "ws",
            Path = "/api/v1/ws",
            Query = "",
            Fragment = "",
            UserName = "",
            Password = "",
        };
        return builder.Uri;
    }
}
