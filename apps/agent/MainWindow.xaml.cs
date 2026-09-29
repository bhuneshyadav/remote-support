using System.ComponentModel;
using System.Net.Http;
using System.Net.WebSockets;
using System.Windows;
using System.Windows.Threading;

namespace RemoteSupportAgent;

public partial class MainWindow : Window
{
    private readonly ApiClient? _api;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly DispatcherTimer _statusTimer;
    private JoinResponse? _request;
    private ScreenPublisher? _publisher;
    private bool _polling;
    private bool _closing;
    private bool _allowClose;
    private bool _sharing;
    private bool _shareStarting;

    public MainWindow()
    {
        InitializeComponent();
        try
        {
            _api = new ApiClient();
        }
        catch (InvalidOperationException error)
        {
            _api = null;
            ErrorText.Text = error.Message;
            JoinButton.IsEnabled = false;
        }

        _statusTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
        _statusTimer.Tick += OnStatusTimerTick;
    }

    private async void OnJoinClick(object sender, RoutedEventArgs e)
    {
        if (_api is null) return;
        SetBusy(true);
        ErrorText.Text = "";
        try
        {
            _request = await _api.JoinAsync(CodeInput.Text, _lifetime.Token);
            OrganizationText.Text = $"Organization: {_request.Session.OrganizationName}";
            TechnicianText.Text = $"Technician: {_request.Session.TechnicianName}";
            PurposeText.Text = $"Request: {_request.Session.Purpose}";
            ExpiryText.Text = $"Expires: {_request.Session.ExpiresAt.ToLocalTime():g}";
            RequestPanel.Visibility = Visibility.Visible;
            EndButton.Visibility = Visibility.Visible;
            CodeInput.IsEnabled = false;
            JoinButton.IsEnabled = false;
            StatusText.Text = "Review who is requesting support and decide whether to allow this request.";
        }
        catch (AgentApiException error)
        {
            ErrorText.Text = error.Message;
        }
        catch (HttpRequestException)
        {
            ErrorText.Text = "Could not connect securely to the support service.";
        }
        catch (TaskCanceledException)
        {
            if (!_lifetime.IsCancellationRequested)
            {
                ErrorText.Text = "The support service took too long to respond. Please try again.";
            }
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async void OnAllowClick(object sender, RoutedEventArgs e)
    {
        if (_request is null || _api is null) return;
        SetBusy(true);
        ErrorText.Text = "";
        try
        {
            var result = await _api.DecideAsync(_request.DecisionToken, "approve", _lifetime.Token);
            DecisionButtons.Visibility = Visibility.Collapsed;
            EndButton.Visibility = Visibility.Visible;
            UpdateSessionStatus(result.Status);
            _statusTimer.Start();
        }
        catch (AgentApiException error)
        {
            ErrorText.Text = error.Message;
        }
        catch (HttpRequestException)
        {
            await RefreshAfterUncertainDecisionAsync();
        }
        catch (TaskCanceledException)
        {
            await RefreshAfterUncertainDecisionAsync();
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async void OnRejectClick(object sender, RoutedEventArgs e)
    {
        if (_request is null || _api is null) return;
        SetBusy(true);
        ErrorText.Text = "";
        try
        {
            var result = await _api.DecideAsync(_request.DecisionToken, "reject", _lifetime.Token);
            UpdateSessionStatus(result.Status);
        }
        catch (AgentApiException error)
        {
            ErrorText.Text = error.Message;
        }
        catch (HttpRequestException)
        {
            await RefreshAfterUncertainDecisionAsync();
        }
        catch (TaskCanceledException)
        {
            await RefreshAfterUncertainDecisionAsync();
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async void OnShareScreenClick(object sender, RoutedEventArgs e)
    {
        if (_request is null || _api is null || _sharing || _shareStarting) return;
        _shareStarting = true;
        ShareScreenButton.IsEnabled = false;
        ErrorText.Text = "";
        ShareNoticeText.Text = "Verifying that the support request is still approved…";
        try
        {
            var status = await _api.GetStatusAsync(_request.CustomerToken, _lifetime.Token);
            if (status.Status != "approved")
            {
                UpdateSessionStatus(status.Status);
                return;
            }
            if (_closing || _lifetime.IsCancellationRequested) return;

            _publisher = new ScreenPublisher(
                _api.BaseUri,
                _request.SessionId,
                _request.CustomerToken,
                text => Dispatcher.InvokeAsync(() => ShareNoticeText.Text = text),
                reason => Dispatcher.InvokeAsync(() => OnPublisherStopped(reason)));
            await _publisher.StartAsync(_lifetime.Token);
            _sharing = true;
            ShareScreenButton.Visibility = Visibility.Collapsed;
            StopSharingButton.Visibility = Visibility.Visible;
            ShareNoticeText.Text = "Waiting for the technician to connect. Your screen is not captured until the server confirms viewing approval and supplies secure connection settings.";
        }
        catch (AgentApiException error)
        {
            ErrorText.Text = error.Message;
        }
        catch (HttpRequestException)
        {
            ErrorText.Text = "Could not verify the request or connect to secure signaling.";
        }
        catch (TaskCanceledException)
        {
            if (!_lifetime.IsCancellationRequested)
            {
                ErrorText.Text = "Could not start screen sharing. Check your connection and try again.";
            }
        }
        catch (InvalidOperationException error)
        {
            ErrorText.Text = error.Message;
            ShareNoticeText.Text = "Screen sharing did not start.";
        }
        catch (WebSocketException)
        {
            ErrorText.Text = "Could not connect to secure screen-sharing signaling.";
            ShareNoticeText.Text = "Screen sharing did not start.";
        }
        catch (OperationCanceledException)
        {
            if (!_lifetime.IsCancellationRequested)
            {
                ErrorText.Text = "Screen sharing did not start.";
            }
        }
        finally
        {
            _shareStarting = false;
            if (!_closing && !_sharing && _request?.Session.Status == "approved")
            {
                if (_publisher is not null)
                {
                    await _publisher.DisposeAsync();
                    _publisher = null;
                }
                ShareScreenButton.IsEnabled = true;
            }
        }
    }

    private async void OnStopSharingClick(object sender, RoutedEventArgs e)
    {
        await StopSharingAsync("Screen sharing stopped. The customer screen is no longer being captured.");
    }

    private async void OnEndClick(object sender, RoutedEventArgs e)
    {
        await EndRequestAsync();
    }

    private void OnNewRequestClick(object sender, RoutedEventArgs e)
    {
        _request = null;
        RequestPanel.Visibility = Visibility.Collapsed;
        DecisionButtons.Visibility = Visibility.Visible;
        EndButton.Visibility = Visibility.Collapsed;
        ShareScreenButton.Visibility = Visibility.Collapsed;
        StopSharingButton.Visibility = Visibility.Collapsed;
        ShareNoticeText.Text = "";
        NewRequestButton.Visibility = Visibility.Collapsed;
        CodeInput.Clear();
        CodeInput.IsEnabled = true;
        JoinButton.IsEnabled = _api is not null;
        StatusText.Text = "";
        ErrorText.Text = "";
        CodeInput.Focus();
    }

    private async void OnStatusTimerTick(object? sender, EventArgs e)
    {
        if (_request is null || _api is null || _polling) return;
        _polling = true;
        try
        {
            var result = await _api.GetStatusAsync(_request.CustomerToken, _lifetime.Token);
            UpdateSessionStatus(result.Status);
        }
        catch (AgentApiException error)
        {
            _statusTimer.Stop();
            ErrorText.Text = error.Message;
            StatusText.Text = "The request is no longer available.";
            await StopSharingAsync("The support request is no longer available.");
            EndButton.Visibility = Visibility.Collapsed;
            NewRequestButton.Visibility = Visibility.Visible;
        }
        catch (HttpRequestException)
        {
            StatusText.Text = "Connection to the support service was lost. The request will expire automatically.";
        }
        catch (TaskCanceledException)
        {
            StatusText.Text = "The support service did not respond. The request will expire automatically.";
        }
        finally
        {
            _polling = false;
        }
    }

    private async Task EndRequestAsync()
    {
        if (_request is null || _api is null) return;
        SetBusy(true);
        ErrorText.Text = "";
        try
        {
            await StopSharingAsync("Screen sharing stopped.");
            var result = await _api.EndAsync(_request.CustomerToken, _lifetime.Token);
            _statusTimer.Stop();
            UpdateSessionStatus(result.Status);
        }
        catch (AgentApiException error)
        {
            ErrorText.Text = error.Message;
        }
        catch (HttpRequestException)
        {
            ErrorText.Text = "Could not reach the service to end the request. It will expire automatically.";
        }
        catch (TaskCanceledException)
        {
            ErrorText.Text = "Could not confirm that the request ended. It will expire automatically.";
        }
        finally
        {
            SetBusy(false);
        }
    }

    private async Task RefreshAfterUncertainDecisionAsync()
    {
        if (_request is null || _api is null)
        {
            ErrorText.Text = "Could not confirm your decision.";
            return;
        }

        try
        {
            var result = await _api.GetStatusAsync(_request.CustomerToken, _lifetime.Token);
            UpdateSessionStatus(result.Status);
            if (result.Status is "approved" or "awaiting_approval" or "waiting_for_customer")
            {
                DecisionButtons.Visibility = result.Status == "approved" ? Visibility.Collapsed : Visibility.Visible;
                EndButton.Visibility = Visibility.Visible;
                _statusTimer.Start();
            }
        }
        catch (AgentApiException error)
        {
            ErrorText.Text = error.Message;
        }
        catch (HttpRequestException)
        {
            ErrorText.Text = "Could not verify whether your decision reached the service. You can cancel the request or wait for it to expire.";
        }
        catch (TaskCanceledException)
        {
            ErrorText.Text = "The status check timed out. You can cancel the request or wait for it to expire.";
        }
    }

    private void UpdateSessionStatus(string status)
    {
        if (_request is not null)
        {
            _request = _request with { Session = _request.Session with { Status = status } };
        }

        StatusText.Text = $"REMOTE SUPPORT REQUEST {status.Replace('_', ' ').ToUpperInvariant()}.";
        if (status == "approved")
        {
            DecisionButtons.Visibility = Visibility.Collapsed;
            EndButton.Visibility = Visibility.Visible;
            if (!_sharing && !_shareStarting)
            {
                ShareScreenButton.Visibility = Visibility.Visible;
                ShareScreenButton.IsEnabled = true;
                ShareNoticeText.Text = "Screen sharing is off. Choose “Share my screen” to start a separate screen-viewing consent.";
            }
            return;
        }

        if (status is "rejected" or "ended" or "expired")
        {
            _statusTimer.Stop();
            _ = StopSharingAsync($"Request {status}. Screen sharing has stopped.");
            DecisionButtons.Visibility = Visibility.Collapsed;
            ShareScreenButton.Visibility = Visibility.Collapsed;
            EndButton.Visibility = Visibility.Collapsed;
            NewRequestButton.Visibility = Visibility.Visible;
        }
        else
        {
            ShareScreenButton.Visibility = Visibility.Collapsed;
            if (status == "awaiting_approval") DecisionButtons.Visibility = Visibility.Visible;
        }
    }

    private async Task StopSharingAsync(string reason)
    {
        var publisher = _publisher;
        _publisher = null;
        _sharing = false;
        if (publisher is not null)
        {
            await publisher.StopAsync();
            await publisher.DisposeAsync();
        }
        StopSharingButton.Visibility = Visibility.Collapsed;
        if (_request?.Session.Status == "approved")
        {
            ShareScreenButton.Visibility = Visibility.Visible;
            ShareScreenButton.IsEnabled = true;
        }
        ShareNoticeText.Text = reason;
    }

    private void OnPublisherStopped(string reason)
    {
        if (_closing) return;
        _ = StopSharingAsync(reason);
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        if (_allowClose) return;
        e.Cancel = true;
        if (_closing) return;
        _closing = true;
        _ = CloseAfterRevokingAsync();
    }

    private async Task CloseAfterRevokingAsync()
    {
        _lifetime.Cancel();
        await StopSharingAsync("Screen sharing stopped because the app is closing.");
        if (_request is not null && _api is not null && _request.Session.Status is not ("ended" or "expired" or "rejected"))
        {
            try
            {
                await _api.EndAsync(_request.CustomerToken, CancellationToken.None);
            }
            catch (AgentApiException error)
            {
                System.Diagnostics.Trace.TraceWarning("Could not revoke customer session during window close: {0}", error.Message);
            }
            catch (HttpRequestException error)
            {
                System.Diagnostics.Trace.TraceWarning("Could not reach support service during window close: {0}", error.GetType().Name);
            }
            catch (TaskCanceledException)
            {
                System.Diagnostics.Trace.TraceWarning("Session revocation timed out while closing the customer agent.");
            }
        }

        _statusTimer.Stop();
        _api?.Dispose();
        _allowClose = true;
        Close();
    }

    private void SetBusy(bool busy)
    {
        JoinButton.IsEnabled = !busy && _request is null;
        AllowButton.IsEnabled = !busy;
        RejectButton.IsEnabled = !busy;
        EndButton.IsEnabled = !busy;
    }
}
