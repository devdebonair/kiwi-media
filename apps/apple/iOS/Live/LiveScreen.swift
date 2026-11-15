import SwiftUI

/// Live TV, modeled on Fubo and UHF. Picking a channel plays it in a player pinned to the top of the tab, with
/// the guide underneath, so viewers can keep looking at what's on now and next while they watch. Turning an
/// iPhone sideways hides the guide and fills the screen with the video; turning it back brings the guide back.
struct LiveScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(LivePlayer.self) private var live
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @State private var model = GuideModel()
    @State private var inspected: InspectedProgram?
    @State private var reveal: String?

    /// iPhone in landscape, or the expand button on iPad: just the video.
    private var isFullscreen: Bool {
        live.isActive && (verticalSizeClass == .compact || live.isExpanded)
    }

    var body: some View {
        GeometryReader { proxy in
            VStack(spacing: 0) {
                if live.isActive {
                    LiveStage(
                        channel: playing?.channel,
                        program: playing?.program,
                        now: model.now,
                        isFullscreen: isFullscreen,
                        onStep: step
                    )
                    .frame(height: isFullscreen ? nil : min(proxy.size.width * 9 / 16, proxy.size.height * 0.45))
                    .frame(maxHeight: isFullscreen ? .infinity : nil)
                    .ignoresSafeArea(edges: isFullscreen ? .all : [])
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
                // Out of the layout entirely in full screen, so rotating only has the video to resize.
                if !isFullscreen {
                    guide.frame(maxHeight: .infinity)
                }
            }
        }
        .onChange(of: isFullscreen) { _, fullscreen in
            // Coming back from full screen: the guide is rebuilt, scrolled to the channel playing.
            if !fullscreen { reveal = live.channelKey }
        }
        .background {
            if live.isActive {
                (isFullscreen ? Color.black : Theme.background).ignoresSafeArea()
            } else {
                TintedBackground(path: spotlight?.1.thumbnailURL)
            }
        }
        .overlay {
            switch model.state {
            case .loading: ProgressView().controlSize(.large)
            case .empty:
                ContentUnavailableView("No channels yet", systemImage: "tv", description: Text("Channels appear once a tag, genre or library has at least three videos."))
            case let .failed(message):
                ContentUnavailableView("Couldn't load the guide", systemImage: "exclamationmark.triangle", description: Text(message))
            case .loaded: EmptyView()
            }
        }
        .navigationTitle("Live")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .topBarTrailing) { ProfileMenu() } }
        .toolbar(live.isActive ? .hidden : .automatic, for: .navigationBar)
        .toolbar(isFullscreen ? .hidden : .automatic, for: .tabBar)
        .statusBarHidden(isFullscreen)
        .persistentSystemOverlays(isFullscreen ? .hidden : .automatic)
        .animation(.snappy, value: live.isActive)
        .sheet(item: $inspected) { item in
            ProgramSheet(channel: item.channel, program: item.program, now: model.now) {
                inspected = nil
                tune(item.channel)
            }
            .presentationDetents([.medium, .large])
        }
        .task {
            if model.state == .loading { await model.refresh(app.api) }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                await model.tick(app.api)
            }
        }
    }

    private var guide: some View {
        GuideGrid(
            channels: model.channels,
            now: model.now,
            windowStart: model.windowStart,
            playingKey: live.channelKey,
            reveal: $reveal,
            onTune: tune,
            onInspect: { channel, program in inspected = InspectedProgram(channel: channel, program: program) }
        ) {
            if let playing, let session = live.session {
                NowPlayingDetails(channel: playing.channel, program: playing.program, next: playing.channel.upNext(at: model.now), session: session)
                    .padding(.horizontal, Theme.pageInset)
                    .padding(.top, 14)
                    .padding(.bottom, 10)
            } else if !live.isActive, let (channel, program) = spotlight {
                SpotlightCard(channel: channel, program: program, now: model.now) { tune(channel) }
                    .padding(.horizontal, Theme.pageInset)
                    .padding(.top, 8)
                    .padding(.bottom, 16)
            }
        }
    }

    // MARK: Actions

    private func tune(_ channel: Channel) {
        live.tune(channel.key, api: app.api)
    }

    private func step(_ offset: Int) {
        if let key = live.step(by: offset, through: model.channels.map(\.key)) {
            reveal = key
        }
    }

    // MARK: Lookups

    /// The channel in the player and what it's airing, from the guide.
    private var playing: (channel: Channel, program: Program?)? {
        guard let key = live.channelKey, let channel = model.channels.first(where: { $0.key == key }) else { return nil }
        return (channel, channel.airing(at: model.now))
    }

    /// The first movie or episode on air, for the big card at the top before anything is playing.
    private var spotlight: (Channel, Program)? {
        for channel in model.channels {
            if let program = channel.airing(at: model.now), program.catalog == true, program.thumbnailURL != nil {
                return (channel, program)
            }
        }
        return nil
    }
}

private struct InspectedProgram: Identifiable {
    let channel: Channel
    let program: Program
    var id: String { "\(channel.key)/\(program.id)" }
}

/// Under the player: what's on, which channel, the time slot, the like button, and what's next.
private struct NowPlayingDetails: View {
    let channel: Channel
    let program: Program?
    let next: Program?
    let session: PlayerSession

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(program?.title ?? channel.name)
                        .font(.title3.weight(.bold))
                        .lineLimit(2)
                    if let subtitle = program?.subtitle {
                        Text(subtitle)
                            .font(.subheadline)
                            .foregroundStyle(Theme.secondaryText)
                            .lineLimit(2)
                    }
                    HStack(spacing: 6) {
                        Chip(text: "\(channel.number) \(channel.name)", systemImage: "dot.radiowaves.left.and.right", prominent: true)
                        if let program {
                            Chip(text: "\(GuideClock.time(program.start)) – \(GuideClock.time(program.end))", systemImage: "clock")
                        }
                    }
                }
                Spacer(minLength: 0)
                LikeButton(level: session.myLikes) {
                    Task { await session.like() }
                }
                .disabled(session.assetId == nil)
            }
            if let next {
                HStack(spacing: 6) {
                    Text("Up next")
                        .font(.caption.weight(.heavy))
                        .foregroundStyle(Theme.accent)
                    Text("\(GuideClock.time(next.start))  \(next.title ?? "Untitled")")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Theme.secondaryText)
                        .lineLimit(1)
                }
            }
        }
    }
}

private struct Chip: View {
    let text: String
    let systemImage: String
    var prominent = false

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .foregroundStyle(prominent ? Color.black : .white)
            .background(Capsule().fill(prominent ? AnyShapeStyle(Theme.accent) : AnyShapeStyle(.white.opacity(0.12))))
    }
}

/// Before anything is playing: the first movie or episode on air, as a big card. Tap to watch.
private struct SpotlightCard: View {
    let channel: Channel
    let program: Program
    let now: Double
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Color.clear
                .aspectRatio(16 / 10, contentMode: .fit)
                .overlay { RemoteImage(path: program.thumbnailURL) }
                .overlay {
                    LinearGradient(colors: [.clear, .black.opacity(0.85)], startPoint: .center, endPoint: .bottom)
                }
                .overlay(alignment: .bottomLeading) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 8) {
                            LiveBadge()
                            Text("\(channel.number)  \(channel.name)")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.white.opacity(0.85))
                        }
                        Text(program.title ?? channel.name)
                            .font(.title2.weight(.bold))
                            .lineLimit(1)
                        if let subtitle = program.subtitle {
                            Text(subtitle).font(.subheadline).foregroundStyle(.white.opacity(0.8)).lineLimit(1)
                        }
                        ProgressBar(value: program.progress(at: now), height: 4)
                            .padding(.top, 4)
                    }
                    .foregroundStyle(.white)
                    .padding(16)
                }
                .overlay {
                    Image(systemName: "play.fill")
                        .font(.title2)
                        .foregroundStyle(.white)
                        .frame(width: 56, height: 56)
                        .glassEffect(.regular, in: .circle)
                }
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(.white.opacity(0.15)))
                .shadow(color: .black.opacity(0.5), radius: 20, y: 10)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Watch \(program.title ?? channel.name) live on \(channel.name)")
    }
}

/// A program later in the guide: when it airs and on which channel, with a way to watch that channel now.
private struct ProgramSheet: View {
    let channel: Channel
    let program: Program
    let now: Double
    let onWatch: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if program.thumbnailURL != nil {
                    Color.clear
                        .aspectRatio(16 / 9, contentMode: .fit)
                        .overlay { RemoteImage(path: program.thumbnailURL) }
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text(startsIn)
                        .font(.caption.weight(.heavy))
                        .foregroundStyle(Theme.accent)
                    Text(program.title ?? "Untitled")
                        .font(.title2.weight(.bold))
                    if let subtitle = program.subtitle {
                        Text(subtitle).font(.subheadline).foregroundStyle(Theme.secondaryText)
                    }
                    Text("\(GuideClock.time(program.start)) – \(GuideClock.time(program.end))  ·  \(channel.number) \(channel.name)")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Theme.secondaryText)
                }
                Button(action: onWatch) {
                    Label("Watch \(channel.name) Live", systemImage: "play.fill")
                        .frame(maxWidth: .infinity)
                }
                .primaryAction()
            }
            .padding(20)
        }
    }

    private var startsIn: String {
        let minutes = Int(((program.start - now) / 60_000).rounded(.up))
        if minutes <= 0 { return "ON NOW" }
        if minutes < 60 { return "STARTS IN \(minutes) MIN" }
        return "AT \(GuideClock.time(program.start).uppercased())"
    }
}
