import SwiftUI

/// The inline live player: video, its loading and error states, and controls that fade in on tap.
///
/// - Tap shows or hides the controls; they hide on their own after a few seconds of playback.
/// - Swipe up or down changes channel.
/// - In full screen, double-tap switches between letterboxed and filling the screen.
struct LiveStage: View {
    let channel: Channel?
    let program: Program?
    let now: Double
    let isFullscreen: Bool
    /// Channel up (+1) or down (-1).
    let onStep: (Int) -> Void

    @Environment(LivePlayer.self) private var live
    @State private var controlsVisible = true
    @State private var hideTask: Task<Void, Never>?

    var body: some View {
        ZStack {
            Color.black
            if let artwork = program?.thumbnailURL ?? channel?.avatarURL, live.session?.phase != .playing {
                RemoteImage(path: artwork)
                    .opacity(0.3)
                    .blur(radius: 6)
                    .clipped()
            }
            LiveVideoSurface(view: live.videoView)
            // Taps and swipes land on this layer, beside the buttons rather than around them, so the double-tap
            // in full screen can never hold up or swallow a tap meant for a button.
            Color.clear
                .contentShape(Rectangle())
                .gesture(tapGesture)
                .simultaneousGesture(swipeGesture)
            status
            if controlsVisible {
                controls.transition(.opacity)
            }
        }
        .onAppear(perform: scheduleHide)
        .onChange(of: live.isPlaying) { _, playing in
            if playing { scheduleHide() } else { show() }
        }
        .onChange(of: live.channelKey) { show() }
        .onChange(of: isFullscreen) { show() }
        .sensoryFeedback(.selection, trigger: live.channelKey)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Live player")
    }

    // MARK: Status

    @ViewBuilder private var status: some View {
        switch live.session?.phase {
        case let .preparing(message):
            VStack(spacing: 10) {
                ProgressView().controlSize(.large).tint(.white)
                Text(message)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white.opacity(0.8))
            }
            .allowsHitTesting(false)
        case let .failed(message):
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill").font(.title2)
                Text(message)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
                Button("Try Again") { live.session?.start() }
                    .secondaryAction()
            }
            .foregroundStyle(.white)
            .padding(24)
        default:
            EmptyView()
        }
    }

    // MARK: Controls

    private var controls: some View {
        ZStack {
            LinearGradient(
                stops: [
                    .init(color: .black.opacity(0.65), location: 0),
                    .init(color: .clear, location: 0.35),
                    .init(color: .clear, location: 0.6),
                    .init(color: .black.opacity(0.75), location: 1),
                ],
                startPoint: .top, endPoint: .bottom
            )
            .allowsHitTesting(false)

            VStack(spacing: 0) {
                topBar
                Spacer(minLength: 0)
                // Only once video is playing, so it never sits on top of the loading or error message.
                transport
                    .opacity(live.session?.phase == .playing ? 1 : 0)
                    .allowsHitTesting(live.session?.phase == .playing)
                Spacer(minLength: 0)
                bottomBar
            }
            .padding(.horizontal, isFullscreen ? 28 : 12)
            .padding(.vertical, isFullscreen ? 20 : 10)
        }
        .foregroundStyle(.white)
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            if isFullscreen {
                ControlButton(systemImage: "chevron.down", label: "Exit Full Screen", action: collapse)
                if let channel {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(channel.number)  \(channel.name)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.8))
                        Text(program?.title ?? channel.name)
                            .font(.headline)
                            .lineLimit(1)
                    }
                    .shadow(radius: 4)
                }
            } else {
                ControlButton(systemImage: "xmark", label: "Stop Watching") {
                    withAnimation(.snappy) { live.stop() }
                }
            }
            Spacer(minLength: 0)
            ControlButton(systemImage: live.isMuted ? "speaker.slash.fill" : "speaker.wave.2.fill", label: live.isMuted ? "Unmute" : "Mute") {
                live.toggleMute()
                scheduleHide()
            }
            if live.canPictureInPicture {
                ControlButton(systemImage: "pip.enter", label: "Picture in Picture") { live.togglePictureInPicture() }
            }
            AirPlayButton()
                .frame(width: 36, height: 36)
                .background(Circle().fill(.black.opacity(0.35)))
                .accessibilityLabel("AirPlay")
        }
    }

    private var transport: some View {
        HStack(spacing: isFullscreen ? 64 : 44) {
            ControlButton(systemImage: "backward.end.fill", label: "Previous Channel", size: 44) { onStep(-1) }
            ControlButton(systemImage: live.isPlaying ? "pause.fill" : "play.fill", label: live.isPlaying ? "Pause" : "Play", size: 60) {
                live.togglePlayback()
            }
            .disabled(live.session?.player == nil)
            ControlButton(systemImage: "forward.end.fill", label: "Next Channel", size: 44) { onStep(1) }
        }
    }

    private var bottomBar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                LiveBadge()
                if let program {
                    Text("Until \(GuideClock.time(program.end))")
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(.white.opacity(0.85))
                }
                Spacer(minLength: 0)
                ControlButton(
                    systemImage: isFullscreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                    label: isFullscreen ? "Exit Full Screen" : "Full Screen",
                    action: isFullscreen ? collapse : expand
                )
            }
            if let program {
                ProgressBar(value: program.progress(at: now), height: 3)
                    .accessibilityHidden(true)
            }
        }
    }

    // MARK: Gestures

    private var tapGesture: AnyGesture<Void> {
        let single = TapGesture().onEnded { toggleControls() }
        guard isFullscreen else { return AnyGesture(single) }
        return AnyGesture(
            TapGesture(count: 2)
                .onEnded { withAnimation(.snappy) { live.fillsScreen.toggle() } }
                .exclusively(before: single)
                .map { _ in () }
        )
    }

    private var swipeGesture: some Gesture {
        DragGesture(minimumDistance: 30)
            .onEnded { value in
                let dy = value.translation.height
                guard abs(dy) > 60, abs(dy) > abs(value.translation.width) * 1.5 else { return }
                onStep(dy < 0 ? 1 : -1)
            }
    }

    private func expand() {
        if UIDevice.current.userInterfaceIdiom == .phone {
            DeviceRotation.request(.landscapeRight)
        } else {
            withAnimation(.snappy) { live.isExpanded = true }
        }
    }

    private func collapse() {
        withAnimation(.snappy) { live.isExpanded = false }
        if UIDevice.current.userInterfaceIdiom == .phone { DeviceRotation.request(.portrait) }
    }

    private func toggleControls() {
        if controlsVisible {
            hideTask?.cancel()
            withAnimation(.easeOut(duration: 0.2)) { controlsVisible = false }
        } else {
            show()
        }
    }

    private func show() {
        withAnimation(.easeOut(duration: 0.2)) { controlsVisible = true }
        scheduleHide()
    }

    private func scheduleHide() {
        hideTask?.cancel()
        hideTask = Task {
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled, live.isPlaying else { return }
            withAnimation(.easeOut(duration: 0.3)) { controlsVisible = false }
        }
    }
}

/// A round, translucent icon button over video.
private struct ControlButton: View {
    let systemImage: String
    let label: String
    var size: CGFloat = 36
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: size * 0.42, weight: .semibold))
                .contentTransition(.symbolEffect(.replace))
                .frame(width: size, height: size)
                .background(Circle().fill(.black.opacity(0.35)))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
