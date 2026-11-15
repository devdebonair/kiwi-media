import MediaPlayer
import SwiftUI

/// Controls for the VLC player, laid out like the iOS system player so on-demand playback looks the same as
/// live channels (which still use the system player):
/// - top: close and Picture in Picture on the left, system volume on the right
/// - middle: skip back, play/pause, skip forward (by the Settings skip interval, 10s unless changed)
/// - bottom: title and subtitle with a ••• menu (speed, audio, subtitles), then the timeline with elapsed and
///   remaining time
///
/// Tap shows or hides them, and they fade after a few seconds of playback, but not while a finger is down or the
/// ••• menu is open. Double-tapping the left or right third
/// of the video skips back or forward (can be turned off in Settings). Pinch switches between fitting and filling
/// the screen. Swipe down closes the player.
struct VLCPlayerControls: View {
    let model: VLCPlaybackModel
    @AppStorage(PlaybackPreferences.doubleTapToSkipKey) private var doubleTapToSkip = true
    @AppStorage(PlaybackPreferences.skipIntervalKey) private var skipInterval = PlaybackPreferences.defaultSkipInterval
    @State private var dismissDrag: CGFloat = 0
    @State private var skipFeedback: SkipFeedback?

    private var interval: Int {
        PlaybackPreferences.skipIntervals.contains(skipInterval) ? skipInterval : PlaybackPreferences.defaultSkipInterval
    }

    var body: some View {
        ZStack {
            GeometryReader { proxy in
                touchSurface(width: proxy.size.width)
            }
            if let skipFeedback {
                SkipFeedbackView(feedback: skipFeedback)
                    .id(skipFeedback.id)
                    .transition(.opacity)
            }

            if showsChrome {
                chrome.transition(.opacity)
            }
            if case let .loading(message) = model.phase {
                LoadingStatus(title: model.title, message: message)
            }
            if case let .failed(message) = model.phase {
                FailureStatus(message: message, close: model.close)
            }
        }
        .offset(y: max(0, dismissDrag))
        .animation(.easeInOut(duration: 0.25), value: showsChrome)
        .animation(.easeOut(duration: 0.2), value: skipFeedback)
        .preferredColorScheme(.dark)
    }

    /// The video area under the controls: taps, double-taps, pinch and swipe down.
    @ViewBuilder
    private func touchSurface(width: CGFloat) -> some View {
        let surface = Color.clear.contentShape(Rectangle())
        let pinch = MagnifyGesture().onEnded { value in model.setFill(value.magnification > 1) }
        if doubleTapToSkip {
            surface
                .onTapGesture(count: 2, coordinateSpace: .local) { location in doubleTap(at: location.x, width: width) }
                .onTapGesture { model.toggleControls() }
                .gesture(pinch)
                .simultaneousGesture(dismissGesture)
        } else {
            surface
                .onTapGesture { model.toggleControls() }
                .gesture(pinch)
                .simultaneousGesture(dismissGesture)
        }
    }

    /// Left third skips back, right third skips forward, the middle just shows or hides the controls.
    /// Double-tapping the same side again soon after adds to the total shown.
    private func doubleTap(at x: CGFloat, width: CGFloat) {
        let side: SkipFeedback.Side
        if x < width / 3 { side = .back } else if x > width * 2 / 3 { side = .forward } else {
            model.toggleControls()
            return
        }
        guard isReady, model.isSeekable else { return }
        model.skip(by: side == .back ? -Double(interval) : Double(interval), revealControls: false)
        let total = (skipFeedback?.side == side ? skipFeedback?.seconds ?? 0 : 0) + interval
        let feedback = SkipFeedback(side: side, seconds: total, symbolSeconds: interval)
        skipFeedback = feedback
        Task {
            try? await Task.sleep(for: .seconds(0.9))
            if skipFeedback?.id == feedback.id { skipFeedback = nil }
        }
    }

    private var showsChrome: Bool {
        if case .playing = model.phase { return model.controlsVisible }
        return true
    }

    private var isReady: Bool {
        switch model.phase {
        case .playing, .ended: true
        default: false
        }
    }

    // MARK: Layout

    private var chrome: some View {
        VStack(spacing: 0) {
            topBar
            Spacer(minLength: 0)
            if isReady { transport }
            Spacer(minLength: 0)
            if isReady { bottomBar }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background {
            VStack(spacing: 0) {
                LinearGradient(colors: [.black.opacity(0.55), .clear], startPoint: .top, endPoint: .bottom).frame(height: 140)
                Spacer()
                LinearGradient(colors: [.clear, .black.opacity(0.65)], startPoint: .top, endPoint: .bottom).frame(height: 220)
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            GlassEffectContainer {
                HStack(spacing: 0) {
                    ChromeButton(symbol: "xmark", label: "Close", action: model.close)
                    if model.pipAvailable {
                        ChromeButton(symbol: "pip.enter", label: "Picture in Picture", action: model.startPictureInPicture)
                    }
                }
                .glassEffect(.regular.interactive(), in: .capsule)
            }
            Spacer()
            HStack(spacing: 8) {
                Image(systemName: "speaker.wave.2.fill")
                    .font(.system(size: 14, weight: .semibold))
                SystemVolumeSlider()
                    .frame(width: 110, height: 44)
            }
            .padding(.horizontal, 14)
            .frame(height: 44)
            .glassEffect(.regular, in: .capsule)
        }
    }

    private var transport: some View {
        HStack(spacing: 40) {
            TransportButton(symbol: "gobackward.\(interval)", size: 24, label: "Back \(interval) seconds") { model.skip(by: -Double(interval)) }
                .disabled(!model.isSeekable)
            TransportButton(symbol: model.phase == .ended ? "arrow.counterclockwise" : (model.isPlaying ? "pause.fill" : "play.fill"),
                            size: 34, label: model.isPlaying ? "Pause" : "Play", action: model.togglePlay)
            TransportButton(symbol: "goforward.\(interval)", size: 24, label: "Forward \(interval) seconds") { model.skip(by: Double(interval)) }
                .disabled(!model.isSeekable)
        }
    }

    private var bottomBar: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .bottom, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    if !model.subtitle.isEmpty {
                        Text(model.subtitle)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.white.opacity(0.7))
                    }
                    Text(model.title)
                        .font(.title3.weight(.semibold))
                }
                .lineLimit(1)
                Spacer(minLength: 0)
                optionsMenu
            }
            Scrubber(model: model)
        }
        .foregroundStyle(.white)
    }

    private var optionsMenu: some View {
        OptionsMenuButton(model: model)
            .frame(width: 44, height: 44)
            .glassEffect(.regular, in: .circle)
    }

    // MARK: Gestures

    /// Swipe down to close, like the system player.
    private var dismissGesture: some Gesture {
        DragGesture(minimumDistance: 20)
            .onChanged { value in
                if value.translation.height > abs(value.translation.width) { dismissDrag = value.translation.height }
            }
            .onEnded { value in
                if value.translation.height > 140 {
                    model.close()
                } else {
                    withAnimation(.spring(duration: 0.3)) { dismissDrag = 0 }
                }
            }
    }
}

/// The timeline: a thin bar that thickens while dragged, elapsed time on the left, time remaining on the right.
private struct Scrubber: View {
    let model: VLCPlaybackModel

    var body: some View {
        let fraction = model.length > 0 ? min(1, max(0, model.displayTime / model.length)) : 0
        let scrubbing = model.scrubTime != nil
        VStack(spacing: 6) {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(.white.opacity(0.3))
                    Capsule().fill(.white).frame(width: proxy.size.width * fraction)
                }
                .frame(height: scrubbing ? 12 : 6)
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in model.scrub(toFraction: value.location.x / max(1, proxy.size.width)) }
                        .onEnded { _ in model.endScrub() }
                )
                .animation(.spring(duration: 0.2), value: scrubbing)
            }
            .frame(height: 24)
            .disabled(!model.isSeekable)

            HStack {
                Text(Self.clock(model.displayTime))
                Spacer()
                Text("-" + Self.clock(max(0, model.length - model.displayTime)))
            }
            .font(.caption.monospacedDigit().weight(.medium))
            .foregroundStyle(.white.opacity(0.7))
        }
        .accessibilityElement()
        .accessibilityLabel("Timeline")
        .accessibilityValue("\(Self.clock(model.displayTime)) of \(Self.clock(model.length))")
    }

    static func clock(_ seconds: Double) -> String {
        let total = max(0, Int(seconds.rounded(.down)))
        let (h, m, s) = (total / 3600, total / 60 % 60, total % 60)
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}

private struct ChromeButton: View {
    let symbol: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

private struct TransportButton: View {
    let symbol: String
    let size: CGFloat
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: size, weight: .semibold))
                .contentTransition(.symbolEffect(.replace))
                .frame(width: size * 2.2, height: size * 2.2)
                .glassEffect(.regular.interactive(), in: .circle)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white)
        .accessibilityLabel(label)
    }
}

private struct LoadingStatus: View {
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 14) {
            ProgressView().controlSize(.large).tint(.white)
            if !title.isEmpty { Text(title).font(.headline) }
            Text(message).font(.subheadline).foregroundStyle(.white.opacity(0.7))
        }
        .multilineTextAlignment(.center)
        .foregroundStyle(.white)
        .padding(32)
        .allowsHitTesting(false)
    }
}

private struct FailureStatus: View {
    let message: String
    let close: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill").font(.largeTitle)
            Text("Can't play this right now").font(.headline)
            Text(message).font(.subheadline).foregroundStyle(.white.opacity(0.7))
            Button("Close", action: close).buttonStyle(.glass)
        }
        .multilineTextAlignment(.center)
        .foregroundStyle(.white)
        .padding(32)
    }
}

/// The ••• menu (speed, audio, subtitles, fill). It's a UIKit menu because SwiftUI's `Menu` doesn't say when
/// it opens or closes, and the controls need to stay up while it's open instead of fading out from under it.
/// Items are built each time it opens, so checkmarks match the player.
private struct OptionsMenuButton: UIViewRepresentable {
    let model: VLCPlaybackModel

    func makeUIView(context: Context) -> MenuButton {
        let button = MenuButton(type: .system)
        var config = UIButton.Configuration.plain()
        config.image = UIImage(systemName: "ellipsis", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold))
        config.baseForegroundColor = .white
        button.configuration = config
        button.showsMenuAsPrimaryAction = true
        button.accessibilityLabel = "More"
        let model = model
        button.menu = UIMenu(children: [UIDeferredMenuElement.uncached { completion in
            MainActor.assumeIsolated { completion(Self.items(for: model)) }
        }])
        button.onMenuChange = { open in model.setMenuOpen(open) }
        return button
    }

    func updateUIView(_ button: MenuButton, context: Context) {}

    private static func items(for model: VLCPlaybackModel) -> [UIMenuElement] {
        let speeds: [Float] = [0.5, 1, 1.25, 1.5, 2]
        var items: [UIMenuElement] = [
            UIMenu(title: "Playback Speed", image: UIImage(systemName: "gauge.with.dots.needle.67percent"), options: .singleSelection,
                   children: speeds.map { rate in
                       UIAction(title: rate == 1 ? "1× (Normal)" : "\(rate.formatted())×", state: model.rate == rate ? .on : .off) { _ in
                           model.setRate(rate)
                       }
                   }),
        ]
        if model.audioTracks.count > 1 {
            items.append(UIMenu(title: "Audio", image: UIImage(systemName: "waveform"), options: .singleSelection,
                                children: model.audioTracks.map { track in
                                    UIAction(title: track.name, state: track.selected ? .on : .off) { _ in model.selectAudio(track.id) }
                                }))
        }
        if !model.textTracks.isEmpty {
            let off = UIAction(title: "Off", state: model.textTracks.contains(where: \.selected) ? .off : .on) { _ in model.selectText(nil) }
            items.append(UIMenu(title: "Subtitles", image: UIImage(systemName: "captions.bubble"), options: .singleSelection,
                                children: [off] + model.textTracks.map { track in
                                    UIAction(title: track.name, state: track.selected ? .on : .off) { _ in model.selectText(track.id) }
                                }))
        }
        let fills = model.fills
        items.append(UIAction(title: fills ? "Fit to Screen" : "Fill Screen",
                              image: UIImage(systemName: fills ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")) { _ in
            model.setFill(!fills)
        })
        return items
    }
}

/// A button that says when its menu opens and closes.
private final class MenuButton: UIButton {
    var onMenuChange: (Bool) -> Void = { _ in }

    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willDisplayMenuFor configuration: UIContextMenuConfiguration,
                                         animator: (any UIContextMenuInteractionAnimating)?) {
        super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
        onMenuChange(true)
    }

    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, willEndFor configuration: UIContextMenuConfiguration,
                                         animator: (any UIContextMenuInteractionAnimating)?) {
        super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
        onMenuChange(false)
    }
}

/// What a double-tap skip shows on its side of the screen.
private struct SkipFeedback: Equatable {
    enum Side { case back, forward }
    let id = UUID()
    let side: Side
    /// Total skipped by this run of double-taps.
    let seconds: Int
    let symbolSeconds: Int
}

private struct SkipFeedbackView: View {
    let feedback: SkipFeedback

    var body: some View {
        let back = feedback.side == .back
        HStack {
            if !back { Spacer() }
            VStack(spacing: 6) {
                Image(systemName: back ? "gobackward.\(feedback.symbolSeconds)" : "goforward.\(feedback.symbolSeconds)")
                    .font(.system(size: 26, weight: .semibold))
                Text("\(feedback.seconds) seconds")
                    .font(.caption.weight(.semibold))
            }
            .foregroundStyle(.white)
            .frame(width: 120, height: 120)
            .glassEffect(.regular, in: .circle)
            .padding(.horizontal, 40)
            if back { Spacer() }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// MPVolumeView puts its slider at the top of its bounds; this centers it so it lines up with the speaker icon.
private final class CenteredVolumeView: MPVolumeView {
    override func volumeSliderRect(forBounds bounds: CGRect) -> CGRect {
        var rect = super.volumeSliderRect(forBounds: bounds)
        rect.origin.y = (bounds.height - rect.height) / 2
        return rect
    }
}

/// The system volume slider (the same one the system player shows), styled for the dark controls.
private struct SystemVolumeSlider: UIViewRepresentable {
    func makeUIView(context: Context) -> MPVolumeView {
        let view = CenteredVolumeView(frame: .zero)
        view.tintColor = .white
        let size = CGSize(width: 14, height: 14)
        let thumb = UIGraphicsImageRenderer(size: size).image { _ in
            UIColor.white.setFill()
            UIBezierPath(ovalIn: CGRect(origin: .zero, size: size)).fill()
        }
        view.setVolumeThumbImage(thumb, for: .normal)
        return view
    }

    func updateUIView(_ uiView: MPVolumeView, context: Context) {}
}
