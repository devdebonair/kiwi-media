import AVFoundation
import SwiftUI

/// Kiwi's Shorts on the big screen: one clip at a time, filling the TV, like the iPhone app's Clips feed.
///
/// - Up and down on the remote move to the previous and next clip; Menu returns to the top navigation.
/// - Play/Pause pauses the clip.
/// - The buttons under the title like the clip (press again to like more, up to five; once more clears it),
///   turn the sound off, and open the title page when the clip belongs to a movie or series.
///
/// More clips load as the viewer nears the end.
struct ClipsScreen: View {
    /// Whether the Clips tab is the one showing; clips only play there.
    let isSelected: Bool

    @Environment(AppModel.self) private var app
    @Environment(\.openItem) private var openItem
    @State private var clips: [Asset] = []
    @State private var index = 0
    /// +1 when the last move was to the next clip, -1 to the previous one; picks the slide direction.
    @State private var direction = 1
    @State private var state: LoadState = .loading
    @State private var exhausted = false
    @State private var muted = false
    @State private var player = ClipPlayer()
    /// Like levels changed here, by clip.
    @State private var likes: [String: Int] = [:]
    @FocusState private var focus: Control?
    /// The button to return focus to after moving between clips.
    @State private var lastButton: Control = .like

    private enum LoadState { case loading, loaded, empty }

    /// The buttons, plus two invisible strips above and below them. The remote can't be read directly, so
    /// moving focus onto a strip is how an up or down press is noticed.
    private enum Control: Hashable { case previous, like, sound, info, next }

    private var clip: Asset? { clips.indices.contains(index) ? clips[index] : nil }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let clip {
                ClipBackdrop(clip: clip, player: player.player)
                    .id(clip.id)
                    .transition(.push(from: direction > 0 ? .bottom : .top))
                    .ignoresSafeArea()
                controls(clip)
            }
            switch state {
            case .loading: ProgressView().controlSize(.large)
            case .empty:
                ContentUnavailableView("No clips yet", systemImage: "play.square.stack", description: Text("Short library videos show up here."))
            case .loaded: EmptyView()
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .onPlayPauseCommand { player.togglePause() }
        .onChange(of: focus) { _, control in
            switch control {
            case .previous: step(-1)
            case .next: step(1)
            case let control?: lastButton = control
            case nil: break
            }
        }
        .onChange(of: isSelected, initial: true) { _, selected in
            if selected { play() } else { player.stop() }
        }
        .onChange(of: muted) { _, value in player.setMuted(value) }
        .onChange(of: app.playRequest) { _, request in
            // Something else is about to play (a title opened from here).
            if request != nil { player.stop() }
        }
        .onChange(of: app.playbackGeneration) { if isSelected { play() } }
        .onDisappear { player.stop() }
        .task {
            if clips.isEmpty { await loadMore() }
        }
    }

    // MARK: Controls

    private func controls(_ clip: Asset) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if index > 0 { edge(.previous) }
            Spacer(minLength: 0)
            HStack(alignment: .bottom, spacing: 40) {
                VStack(alignment: .leading, spacing: 22) {
                    info(clip)
                    HStack(spacing: 20) {
                        let level = likes[clip.id] ?? clip.myLikes
                        Button {
                            Task { await like(clip) }
                        } label: {
                            Label(LikeLevel.label(level), systemImage: level > 0 ? "heart.fill" : "heart")
                                .contentTransition(.symbolEffect(.replace))
                        }
                        .primaryAction()
                        .focused($focus, equals: .like)

                        Button {
                            muted.toggle()
                        } label: {
                            Label(muted ? "Sound Off" : "Sound On", systemImage: muted ? "speaker.slash.fill" : "speaker.wave.2.fill")
                                .contentTransition(.symbolEffect(.replace))
                        }
                        .secondaryAction()
                        .focused($focus, equals: .sound)

                        if let ref = clip.catalog?.titleId ?? clip.titleId {
                            Button {
                                openItem(TileItem(id: ref, title: clip.catalog?.title ?? clip.displayTitle, action: .title(ref: ref)))
                            } label: {
                                Label("More Info", systemImage: "info.circle")
                            }
                            .secondaryAction()
                            .focused($focus, equals: .info)
                        }
                    }
                }
                Spacer(minLength: 0)
                pager
            }
            .padding(.bottom, 8)
            if index < clips.count - 1 { edge(.next) }
        }
        .defaultFocus($focus, .like)
        .focusSection()
    }

    private func info(_ clip: Asset) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(clip.catalog?.title ?? clip.displayTitle)
                .font(.title2.weight(.bold))
                .lineLimit(2)
                .frame(maxWidth: 1000, alignment: .leading)
            let tags = clip.topics.prefix(3).map(\.name)
            if !tags.isEmpty {
                Text(tags.joined(separator: " • "))
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.85))
            }
            HStack(spacing: 22) {
                if let duration = clip.durationMs { Label(TileItem.duration(duration), systemImage: "clock") }
                if clip.viewCount > 0 { Label("\(clip.viewCount)", systemImage: "eye") }
                if player.isPaused { Label("Paused", systemImage: "pause.fill") }
            }
            .font(.caption)
            .foregroundStyle(.white.opacity(0.75))
        }
        .shadow(color: .black.opacity(0.6), radius: 8)
    }

    /// Which way the remote moves through the feed.
    private var pager: some View {
        VStack(spacing: 10) {
            Image(systemName: "chevron.up").opacity(index > 0 ? 1 : 0.25)
            Text("\(index + 1)")
                .font(.caption.weight(.bold).monospacedDigit())
            Image(systemName: "chevron.down").opacity(index < clips.count - 1 ? 1 : 0.25)
        }
        .font(.callout.weight(.bold))
        .foregroundStyle(.white.opacity(0.8))
        .padding(.vertical, 18)
        .padding(.horizontal, 20)
        .background(Capsule().fill(.black.opacity(0.4)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Clip \(index + 1). Move up or down for more clips.")
    }

    /// An invisible strip that takes focus when the viewer moves past the buttons.
    private func edge(_ control: Control) -> some View {
        Color.clear
            .frame(maxWidth: .infinity)
            .frame(height: 12)
            .focusable()
            .focused($focus, equals: control)
            .accessibilityHidden(true)
    }

    // MARK: Actions

    private func step(_ offset: Int) {
        let target = index + offset
        guard clips.indices.contains(target) else {
            focus = lastButton
            return
        }
        direction = offset
        withAnimation(.snappy(duration: 0.35)) { index = target }
        play()
        // Once the new clip's buttons are in place.
        Task { focus = lastButton }
        if target >= clips.count - 3 { Task { await loadMore() } }
    }

    /// Starts the clip on screen with a fresh player, so each clip counts its own view.
    private func play() {
        player.stop()
        guard isSelected, let clip else { return }
        let next = ClipPlayer()
        player = next
        next.start(clip, api: app.api, muted: muted)
    }

    /// One more like, up to five; at five, another press clears it (the same as a title page).
    private func like(_ clip: Asset) async {
        let previous = likes[clip.id] ?? clip.myLikes
        let target = previous >= LikeLevel.maximum ? 0 : previous + 1
        likes[clip.id] = target
        do {
            likes[clip.id] = try await app.api.setLikes(clip.id, count: target).myLikes ?? target
        } catch {
            likes[clip.id] = previous
        }
    }

    private func loadMore() async {
        guard !exhausted else { return }
        let page = (try? await app.api.shorts(limit: 20, offset: clips.count)) ?? []
        let known = Set(clips.map(\.id))
        let wasEmpty = clips.isEmpty
        clips += page.filter { !known.contains($0.id) }
        exhausted = page.count < 20
        state = clips.isEmpty ? .empty : .loaded
        if wasEmpty { play() }
    }
}

/// One clip filling the screen: the whole picture, over a blurred copy of its thumbnail so upright videos
/// don't sit between plain black bars.
private struct ClipBackdrop: View {
    let clip: Asset
    let player: AVPlayer?

    var body: some View {
        ZStack {
            RemoteImage(path: clip.thumbnailURL)
                .blur(radius: 60)
                .opacity(0.55)
            RemoteImage(path: clip.thumbnailURL, contentMode: .fit)
            if let player {
                PlayerLayerView(player: player, gravity: .resizeAspect)
                    .transition(.opacity)
            }
            LinearGradient(
                stops: [.init(color: .black.opacity(0.4), location: 0), .init(color: .clear, location: 0.25), .init(color: .clear, location: 0.55), .init(color: .black.opacity(0.85), location: 1)],
                startPoint: .top, endPoint: .bottom
            )
        }
        .clipped()
    }
}
