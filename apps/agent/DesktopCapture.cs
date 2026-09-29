using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows;

namespace RemoteSupportAgent;

internal sealed class DesktopCapture : IDisposable
{
    private const int CaptureWidth = 640;
    private const int CaptureHeight = 360;
    private readonly Bitmap _bitmap = new(CaptureWidth, CaptureHeight, PixelFormat.Format24bppRgb);
    private readonly Graphics _graphics;
    private readonly Bitmap _desktopBitmap;
    private readonly Graphics _desktopGraphics;
    private readonly System.Drawing.Rectangle _desktopBounds;

    public DesktopCapture()
    {
        _desktopBounds = System.Windows.Forms.Screen.PrimaryScreen?.Bounds
            ?? throw new InvalidOperationException("No visible Windows desktop is available for screen capture.");
        _desktopBitmap = new Bitmap(_desktopBounds.Width, _desktopBounds.Height, PixelFormat.Format24bppRgb);
        _desktopGraphics = Graphics.FromImage(_desktopBitmap);
        _graphics = Graphics.FromImage(_bitmap);
        _graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
    }

    public byte[] CaptureBgrFrame()
    {
        _desktopGraphics.CopyFromScreen(
            _desktopBounds.Left,
            _desktopBounds.Top,
            0,
            0,
            new System.Drawing.Size(_desktopBounds.Width, _desktopBounds.Height),
            CopyPixelOperation.SourceCopy);
        _graphics.DrawImage(_desktopBitmap, new System.Drawing.Rectangle(0, 0, CaptureWidth, CaptureHeight));

        var rectangle = new System.Drawing.Rectangle(0, 0, CaptureWidth, CaptureHeight);
        var data = _bitmap.LockBits(rectangle, ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try
        {
            var frame = new byte[CaptureWidth * CaptureHeight * 3];
            var row = new byte[CaptureWidth * 3];
            for (var y = 0; y < CaptureHeight; y++)
            {
                Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                Buffer.BlockCopy(row, 0, frame, y * row.Length, row.Length);
            }
            return frame;
        }
        finally
        {
            _bitmap.UnlockBits(data);
        }
    }

    public void Dispose()
    {
        _graphics.Dispose();
        _bitmap.Dispose();
        _desktopGraphics.Dispose();
        _desktopBitmap.Dispose();
    }
}

internal sealed class CaptureIndicator : IDisposable
{
    private readonly Window _window;

    public CaptureIndicator(Action stop)
    {
        var button = new System.Windows.Controls.Button
        {
            Content = "Stop sharing",
            Padding = new Thickness(14, 6, 14, 6),
            Margin = new Thickness(12, 6, 12, 6),
            Background = System.Windows.Media.Brushes.DarkRed,
            Foreground = System.Windows.Media.Brushes.White,
            FontWeight = FontWeights.Bold,
        };
        button.Click += (_, _) => stop();

        var label = new System.Windows.Controls.TextBlock
        {
            Text = "YOUR SCREEN IS BEING SHARED",
            VerticalAlignment = VerticalAlignment.Center,
            Foreground = System.Windows.Media.Brushes.White,
            FontWeight = FontWeights.Bold,
            Margin = new Thickness(14, 6, 8, 6),
        };
        var panel = new System.Windows.Controls.StackPanel
        {
            Orientation = System.Windows.Controls.Orientation.Horizontal,
            Children = { label, button },
        };

        _window = new Window
        {
            Title = "Screen sharing is active",
            Content = panel,
            SizeToContent = SizeToContent.WidthAndHeight,
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            Topmost = true,
            ShowActivated = false,
            ShowInTaskbar = false,
            Background = System.Windows.Media.Brushes.DarkRed,
            AllowsTransparency = false,
            Left = 16,
            Top = 16,
        };
        _window.Show();
    }

    public void Dispose() => _window.Close();
}
