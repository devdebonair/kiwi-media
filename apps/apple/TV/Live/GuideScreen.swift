import SwiftUI

/// Live TV, laid out like Peacock's and UHF's guides: the channel being watched keeps playing across the whole
/// screen, and the guide sits over it, so viewers can browse what's on without losing what they're watching.
///
/// - The top left describes the program in focus.
/// - Below, a timeline: every channel is a row of programs sized by running time against a shared time ruler,
///   with a line at the current time. Moving past the right edge pages the timeline forward half an hour.
/// - Select on what's on now watches that channel full screen; Menu there comes back to the guide.
/// - Play/Pause on what's on now switches the background to that channel without leaving the guide.
/// - Select on a later program offers to play it from the start.
///
/// The Live tab tunes to the last channel watched when it opens.
struct GuideScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(LivePlayer.self) private var live
    @Environment(\.openItem) private var openItem
    @State private var model = GuideModel()
    @FocusState private var focusKey: String?
    /// Start of the stretch of time on screen; a half-hour boundary.
    @State private var pageStart: Double = Self.slot(GuideClock.now)
    /// A later program the viewer selected, for the play-from-start question.
    @State private var upcoming: UpcomingProgram?

    static let halfHour: Double = 1_800_000
    /// How much time the timeline shows at once.
    static let span: Double = 90 * 60_000
    static let channelColumn: CGFloat = 250
    static let rowHeight: CGFloat = 84
    static let rowSpacing: CGFloat = 10

    var body: some View {
        ZStack(alignment: .topLeading) {
            background
            switch model.state {
            case .loading:
                ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
            case .empty:
                ContentUnavailableView("No channels yet", systemImage: "tv", description: Text("Channels appear once a tag, genre or library has at least three videos."))
            case let .failed(message):
                ContentUnavailableView("Couldn't load the guide", systemImage: "exclamationmark.triangle", description: Text(message))
            case .loaded:
                GeometryReader { proxy in
                    guide(laneWidth: proxy.size.width - Self.channelColumn - Theme.pageInset * 2)
                }
            }
        }
        .ignoresSafeArea(edges: .horizontal)
        .onPlayPauseCommand(perform: preview)
        .confirmationDialog(upcoming?.program.title ?? "", isPresented: Binding { upcoming != nil } set: { if !$0 { upcoming = nil } }, presenting: upcoming) { item in
            Button("Play from the Start") { app.play(item.program.assetId, startOver: true) }
            if let ref = item.program.titleId {
                Button("More Info") { openItem(TileItem(id: ref, title: item.program.title ?? "", action: .title(ref: ref))) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { item in
            Text("\(GuideClock.time(item.program.start)) on \(item.channel.number) \(item.channel.name)")
        }
        .task {
            if model.state == .loading { await model.refresh(app.api) }
            tuneInitialChannel()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                await model.tick(app.api)
                let current = Self.slot(model.now)
                if pageStart < current { pageStart = current }
            }
        }
    }

    // MARK: Background

    /// The channel playing, across the whole screen, darkened where the guide sits over it.
    private var background: some View {
        ZStack {
            Color.black
            if let player = live.session?.player, !live.isFullscreen {
                PlayerLayerView(player: player, gravity: .resizeAspectFill)
                    .transition(.opacity)
            } else if let art = focused?.program.thumbnailURL {
                RemoteImage(path: art).opacity(0.5)
            }
            LinearGradient(
                stops: [.init(color: .black.opacity(0.9), location: 0), .init(color: .black.opacity(0.55), location: 0.4), .init(color: .clear, location: 0.7)],
                startPoint: .leading, endPoint: .trailing
            )
            LinearGradient(
                stops: [.init(color: .black.opacity(0.35), location: 0), .init(color: .clear, location: 0.15), .init(color: .black.opacity(0.75), location: 0.42), .init(color: .black.opacity(0.95), location: 0.6)],
                startPoint: .top, endPoint: .bottom
            )
        }
        .ignoresSafeArea()
        .animation(.easeInOut(duration: 0.4), value: live.channelKey)
    }

    // MARK: Guide

    private func guide(laneWidth: CGFloat) -> some View {
        let timeline = Timeline(start: pageStart, span: Self.span, width: laneWidth)
        return VStack(alignment: .leading, spacing: 0) {
            ProgramInfo(focused: focused, now: model.now, isPlaying: focused?.channel.key == live.channelKey, phase: live.session?.phase)
                .frame(height: 330, alignment: .bottomLeading)
                .padding(.horizontal, Theme.pageInset)
                .padding(.top, 110)
            TimeRuler(timeline: timeline, now: model.now, isAtNow: pageStart <= Self.slot(model.now))
                .padding(.horizontal, Theme.pageInset)
                .padding(.top, 26)
            ScrollViewReader { proxy in
                ScrollView(.vertical) {
                    LazyVStack(alignment: .leading, spacing: Self.rowSpacing) {
                        ForEach(model.channels) { channel in
                            GuideRow(
                                channel: channel,
                                timeline: timeline,
                                now: model.now,
                                isPlaying: channel.key == live.channelKey,
                                focus: $focusKey,
                                select: { select($0, on: channel) },
                                page: { direction, program in page(direction, from: program, on: channel) }
                            )
                            .id(channel.key)
                        }
                    }
                    .padding(.horizontal, Theme.pageInset)
                    .padding(.top, 12)
                    .padding(.bottom, 800)
                }
                // Rows slide under the ruler rather than over it.
                .clipped()
                .overlay(alignment: .topLeading) { nowLine(timeline) }
                .onAppear {
                    if let key = live.channelKey ?? LivePlayer.lastChannel {
                        proxy.scrollTo(rowAbove(key), anchor: .top)
                    }
                }
                .onChange(of: focusedChannel) { _, key in
                    // The row in focus stays second from the top, with the row above it still in view.
                    guard let key else { return }
                    withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(rowAbove(key), anchor: .top) }
                }
            }
        }
        .defaultFocus($focusKey, initialFocus)
    }

    /// The current time, as a line down the timeline.
    @ViewBuilder private func nowLine(_ timeline: Timeline) -> some View {
        if let x = timeline.x(model.now), x > 0 {
            Rectangle()
                .fill(Theme.accent)
                .frame(width: 3)
                .frame(maxHeight: .infinity)
                .offset(x: Theme.pageInset + Self.channelColumn + x - 1.5)
                .allowsHitTesting(false)
        }
    }

    // MARK: Actions

    private func select(_ program: Program, on channel: Channel) {
        if program.start <= model.now && model.now < program.end {
            live.tune(channel.key, api: app.api)
            live.isFullscreen = true
        } else {
            upcoming = UpcomingProgram(channel: channel, program: program)
        }
    }

    /// Play/Pause: switches the background to the channel in focus, or pauses it if it's already on.
    private func preview() {
        guard let channel = focusKey?.split(separator: "|", maxSplits: 1).first.map(String.init), channel != live.channelKey else {
            live.togglePlayback()
            return
        }
        live.tune(channel, api: app.api)
    }

    /// Moves the timeline half an hour when focus is pushed past its edge, keeping focus on the program it was on,
    /// or on the next one along if that one has scrolled out of view.
    private func page(_ direction: MoveCommandDirection, from program: Program, on channel: Channel) {
        let earliest = Self.slot(model.now)
        let latest = model.windowStart + 4 * 3_600_000 - Self.span
        switch direction {
        case .right where pageStart < latest:
            pageStart += Self.halfHour
            if program.end <= pageStart + Self.span - Self.halfHour,
               let next = channel.programs.first(where: { $0.start >= program.end }) {
                focusKey = Self.key(channel, next)
            }
        case .left where pageStart > earliest:
            pageStart -= Self.halfHour
            if program.start >= pageStart + Self.halfHour,
               let previous = channel.programs.last(where: { $0.end <= program.start }) {
                focusKey = Self.key(channel, previous)
            }
        default:
            break
        }
    }

    private func tuneInitialChannel() {
        guard !live.isActive, let channel = model.channels.first(where: { $0.key == LivePlayer.lastChannel }) ?? model.channels.first else { return }
        live.tune(channel.key, api: app.api)
    }

    // MARK: Lookups

    private var focusedChannel: String? {
        focusKey?.split(separator: "|", maxSplits: 1).first.map(String.init)
    }

    private func rowAbove(_ key: String) -> String {
        guard let index = model.channels.firstIndex(where: { $0.key == key }), index > 0 else { return key }
        return model.channels[index - 1].key
    }

    private var focused: (channel: Channel, program: Program)? {
        if let key = focusKey {
            let parts = key.split(separator: "|", maxSplits: 1).map(String.init)
            if parts.count == 2, let channel = model.channels.first(where: { $0.key == parts[0] }),
               let program = channel.programs.first(where: { $0.id == parts[1] }) {
                return (channel, program)
            }
        }
        guard let channel = model.channels.first(where: { $0.key == live.channelKey }) ?? model.channels.first,
              let program = channel.airing(at: model.now) else { return nil }
        return (channel, program)
    }

    /// What's on now on the channel playing.
    private var initialFocus: String? {
        guard let channel = model.channels.first(where: { $0.key == (live.channelKey ?? LivePlayer.lastChannel) }) ?? model.channels.first,
              let program = channel.airing(at: model.now) else { return nil }
        return Self.key(channel, program)
    }

    static func key(_ channel: Channel, _ program: Program) -> String { "\(channel.key)|\(program.id)" }

    static func slot(_ time: Double) -> Double { (time / halfHour).rounded(.down) * halfHour }
}

private struct UpcomingProgram: Identifiable {
    let channel: Channel
    let program: Program
    var id: String { GuideScreen.key(channel, program) }
}

/// Maps times onto the part of the timeline on screen.
struct Timeline: Equatable {
    let start: Double
    let span: Double
    let width: CGFloat

    var end: Double { start + span }
    var perMillisecond: CGFloat { width / CGFloat(span) }

    /// Position of `time`, or nil when it's off screen.
    func x(_ time: Double) -> CGFloat? {
        guard time >= start, time <= end else { return nil }
        return CGFloat(time - start) * perMillisecond
    }

    func width(from: Double, to: Double) -> CGFloat {
        CGFloat(min(to, end) - max(from, start)) * perMillisecond
    }
}

// MARK: - Program details

/// The program in focus, at the top of the guide: channel, title, episode, when it airs, and what pressing
/// Select will do.
private struct ProgramInfo: View {
    let focused: (channel: Channel, program: Program)?
    let now: Double
    let isPlaying: Bool
    let phase: PlayerSession.Phase?

    var body: some View {
        if let (channel, program) = focused {
            let airing = program.start <= now && now < program.end
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 14) {
                    ChannelLogo(channel: channel)
                        .frame(width: 52, height: 52)
                    Text("\(channel.number)  \(channel.name)")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.85))
                    if airing { LiveBadge() }
                    if isPlaying, airing {
                        Label("Watching", systemImage: "play.fill")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(Theme.accent)
                    }
                }
                Text(program.title ?? channel.name)
                    .font(.system(size: 54, weight: .bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if let subtitle = program.subtitle {
                    Text(subtitle)
                        .font(.title3)
                        .foregroundStyle(.white.opacity(0.85))
                        .lineLimit(1)
                }
                HStack(spacing: 18) {
                    Text("\(GuideClock.time(program.start)) – \(GuideClock.time(program.end))")
                        .font(.callout.weight(.semibold).monospacedDigit())
                    if airing {
                        ProgressBar(value: program.progress(at: now), height: 6)
                            .frame(width: 220)
                        Text("\(max(1, Int((program.end - now) / 60_000))) min left")
                            .font(.callout.monospacedDigit())
                            .foregroundStyle(Theme.secondaryText)
                    }
                }
                Text(hint(airing: airing))
                    .font(.caption)
                    .foregroundStyle(Theme.secondaryText)
            }
            .frame(maxWidth: 1100, alignment: .leading)
            .shadow(color: .black.opacity(0.6), radius: 10)
            .id(GuideScreen.key(channel, program))
            .transition(.opacity)
            .animation(.easeOut(duration: 0.15), value: GuideScreen.key(channel, program))
        }
    }

    private func hint(airing: Bool) -> String {
        guard airing else { return "Select to play from the start" }
        if isPlaying { return "Select to watch full screen" }
        return "Select to watch  ·  Play/Pause to preview while you browse"
    }
}

// MARK: - Timeline

/// "Today" over the channel column, then the half hours across the timeline.
private struct TimeRuler: View {
    let timeline: Timeline
    let now: Double
    let isAtNow: Bool

    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: 10) {
                if !isAtNow {
                    Image(systemName: "chevron.left").font(.caption.weight(.bold))
                }
                Text("Today")
                    .font(.callout.weight(.bold))
            }
            .frame(width: GuideScreen.channelColumn, alignment: .leading)
            ZStack(alignment: .leading) {
                ForEach(Array(stride(from: timeline.start, to: timeline.end, by: GuideScreen.halfHour)), id: \.self) { slot in
                    Text(GuideClock.time(slot))
                        .font(.callout.weight(.semibold).monospacedDigit())
                        .foregroundStyle(Theme.secondaryText)
                        .fixedSize()
                        .offset(x: (timeline.x(slot) ?? 0) + 8)
                }
                if let x = timeline.x(now) {
                    Capsule().fill(Theme.accent).frame(width: 3, height: 26).offset(x: x - 1.5)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .clipped()
        }
        .frame(height: 40)
    }
}

/// One channel: its logo and number, then its programs across the timeline.
private struct GuideRow: View {
    let channel: Channel
    let timeline: Timeline
    let now: Double
    let isPlaying: Bool
    var focus: FocusState<String?>.Binding
    let select: (Program) -> Void
    let page: (MoveCommandDirection, Program) -> Void

    var body: some View {
        let programs = channel.programs.filter { $0.end > timeline.start && $0.start < timeline.end }
        HStack(spacing: 0) {
            ChannelTile(channel: channel, isPlaying: isPlaying)
                .frame(width: GuideScreen.channelColumn, alignment: .leading)
            HStack(spacing: 0) {
                if programs.isEmpty {
                    Text("No listings")
                        .font(.caption)
                        .foregroundStyle(Theme.secondaryText)
                        .padding(.horizontal, 20)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.white.opacity(0.05)))
                }
                ForEach(Array(programs.enumerated()), id: \.element.id) { index, program in
                    // Gaps in the schedule stay empty.
                    let gapStart = index == 0 ? timeline.start : programs[index - 1].end
                    if program.start > gapStart {
                        Color.clear.frame(width: timeline.width(from: gapStart, to: program.start))
                    }
                    ProgramCell(
                        program: program,
                        timeline: timeline,
                        now: now,
                        isPlaying: isPlaying
                    ) {
                        select(program)
                    }
                    .focused(focus, equals: GuideScreen.key(channel, program))
                    .onMoveCommand { direction in
                        if direction == .right, index == programs.count - 1 { page(.right, program) }
                        if direction == .left, index == 0 { page(.left, program) }
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(width: timeline.width, alignment: .leading)
        }
        .frame(height: GuideScreen.rowHeight)
    }
}

private struct ChannelTile: View {
    let channel: Channel
    let isPlaying: Bool

    var body: some View {
        HStack(spacing: 14) {
            ChannelLogo(channel: channel)
                .frame(width: 64, height: 64)
                .overlay {
                    if isPlaying {
                        RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.accent, lineWidth: 3)
                    }
                }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if isPlaying { Image(systemName: "play.fill").font(.caption2) }
                    Text("\(channel.number)").font(.caption.weight(.heavy).monospacedDigit())
                }
                .foregroundStyle(isPlaying ? Theme.accent : Theme.secondaryText)
                Text(channel.name)
                    .font(.caption.weight(.semibold))
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.trailing, 12)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Channel \(channel.number), \(channel.name)\(isPlaying ? ", playing" : "")")
    }
}

/// A channel's logo on a rounded tile, or a stand-in symbol.
struct ChannelLogo: View {
    let channel: Channel

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white.opacity(0.12))
            if channel.avatarURL != nil {
                RemoteImage(path: channel.avatarURL)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            } else {
                Image(systemName: channel.type == "custom" ? "square.stack.3d.up" : "tv")
                    .font(.title3)
                    .foregroundStyle(Theme.secondaryText)
            }
        }
    }
}

/// A program as wide as its time on screen: title and time on a translucent block, white while in focus. What's on
/// now shows how far along it is.
private struct ProgramCell: View {
    let program: Program
    let timeline: Timeline
    let now: Double
    let isPlaying: Bool
    let action: () -> Void

    var body: some View {
        let width = timeline.width(from: program.start, to: program.end)
        Button(action: action) {
            ProgramCellLabel(
                program: program,
                airing: program.start <= now && now < program.end,
                isPlaying: isPlaying,
                elapsed: program.start <= now ? timeline.width(from: program.start, to: min(now, program.end)) : 0,
                continuesBefore: program.start < timeline.start,
                compact: width < 170
            )
        }
        .buttonStyle(GuideCellStyle())
        .frame(width: max(1, width))
        .accessibilityLabel("\(program.title ?? "Untitled"), \(GuideClock.time(program.start)) to \(GuideClock.time(program.end))")
    }
}

private struct ProgramCellLabel: View {
    let program: Program
    let airing: Bool
    let isPlaying: Bool
    let elapsed: CGFloat
    let continuesBefore: Bool
    let compact: Bool

    @Environment(\.isFocused) private var isFocused

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if continuesBefore {
                    Image(systemName: "chevron.left").font(.caption2.weight(.bold))
                }
                Text(program.title ?? "Untitled")
                    .font(compact ? .caption.weight(.semibold) : .callout.weight(.semibold))
                    .lineLimit(compact ? 2 : 1)
            }
            if !compact {
                Text(program.subtitle ?? "\(GuideClock.time(program.start)) – \(GuideClock.time(program.end))")
                    .font(.caption)
                    .foregroundStyle(isFocused ? Color.black.opacity(0.6) : Theme.secondaryText)
                    .lineLimit(1)
            }
        }
        .foregroundStyle(isFocused ? Color.black : Color.white)
        .padding(.horizontal, compact ? 8 : 18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(alignment: .leading) {
            ZStack(alignment: .leading) {
                Rectangle().fill(isFocused ? Color.white : Color.white.opacity(airing ? 0.16 : 0.08))
                if airing, !isFocused {
                    Rectangle().fill(.white.opacity(0.1)).frame(width: elapsed)
                }
            }
        }
        .overlay {
            if isPlaying, airing, !isFocused {
                RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.accent, lineWidth: 3)
            }
        }
    }
}

/// Guide cells: no lift or tilt, so the grid stays lined up; focus shows as a white cell.
private struct GuideCellStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .padding(.trailing, 6)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
    }
}
