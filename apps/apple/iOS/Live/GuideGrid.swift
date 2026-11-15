import SwiftUI

/// The channel guide, in one of two layouts the viewer moves between by pinching:
/// - **Timeline**: channels down the left, programs along a timeline that scrolls sideways to what's coming
///   up. Pinch out to zoom in (taller rows, more room per minute) and pinch in to zoom out.
/// - **Channel grid**: pinching in past the smallest timeline drops the timeline and shows every channel as a
///   tile with what it's airing now. Pinch out (or tap Guide) to bring the timeline back.
///
/// The zoom level and layout are remembered between launches.
struct GuideGrid<Header: View>: View {
    let channels: [Channel]
    let now: Double
    /// Where the timeline begins: the start of the current half hour.
    let windowStart: Double
    /// The channel playing in the player, highlighted.
    let playingKey: String?
    /// Set to a channel key to scroll that channel into view.
    @Binding var reveal: String?
    let onTune: (Channel) -> Void
    let onInspect: (Channel, Program) -> Void
    /// Content above the guide that scrolls away (the now-playing details or the spotlight).
    @ViewBuilder let header: Header

    @AppStorage("live.guide.zoom") private var zoom: Double = 1
    @AppStorage("live.guide.channelGrid") private var showsChannelGrid = false

    var body: some View {
        ZStack {
            if showsChannelGrid {
                ChannelGridGuide(
                    channels: channels,
                    now: now,
                    playingKey: playingKey,
                    reveal: $reveal,
                    onTune: onTune,
                    onShowTimeline: { setChannelGrid(false) },
                    header: header
                )
                .transition(.opacity.combined(with: .scale(scale: 1.04)))
            } else {
                TimelineGuide(
                    channels: channels,
                    now: now,
                    windowStart: windowStart,
                    playingKey: playingKey,
                    reveal: $reveal,
                    savedZoom: $zoom,
                    onTune: onTune,
                    onInspect: onInspect,
                    onShowChannelGrid: { setChannelGrid(true) },
                    header: header
                )
                .transition(.opacity.combined(with: .scale(scale: 0.96)))
            }
        }
    }

    private func setChannelGrid(_ on: Bool) {
        if !on { zoom = Double(GuideMetrics.minZoom) }
        reveal = playingKey
        withAnimation(.snappy) { showsChannelGrid = on }
    }
}

// MARK: Metrics

/// Sizes at a zoom level, and the time-to-points mapping the ruler and rows share.
private struct GuideMetrics: Equatable {
    static let minZoom: CGFloat = 0.65
    static let maxZoom: CGFloat = 2.2
    static let channelColumn: CGFloat = 86
    static let rulerHeight: CGFloat = 36
    static let rowSpacing: CGFloat = 6
    static let halfHour: Double = 1_800_000

    let windowStart: Double
    let end: Double
    let zoom: CGFloat

    var perMinute: CGFloat { 4.5 * zoom }
    /// Rows grow more slowly than time does, so zooming in mostly spreads programs out.
    var rowHeight: CGFloat { (62 * pow(zoom, 0.6)).rounded() }
    var rowPitch: CGFloat { rowHeight + Self.rowSpacing }
    var pageWidth: CGFloat { 30 * perMinute }

    /// Points from the start of the timeline (not counting the channel column).
    func x(_ time: Double) -> CGFloat {
        CGFloat((time - windowStart) / 60_000) * perMinute
    }

    var timelineWidth: CGFloat { x(end) }
    var contentWidth: CGFloat { Self.channelColumn + timelineWidth + 12 }

    /// The last half hour the timeline covers: as far as the guide has programs, up to four hours out.
    static func end(of channels: [Channel], from start: Double) -> Double {
        var latest = start + 2 * halfHour
        for channel in channels {
            if let end = channel.programs.last?.end, end > latest { latest = end }
        }
        let capped = min(latest, start + 8 * halfHour)
        return max(start + 2 * halfHour, (capped / halfHour).rounded(.up) * halfHour)
    }
}

private extension View {
    /// Keeps a view at the leading edge of the viewport while its scroll view scrolls sideways. Runs at render
    /// time, so scrolling never re-evaluates the view.
    func stickyLeading() -> some View {
        visualEffect { content, geometry in
            content.offset(x: max(0, -geometry.frame(in: .scrollView(axis: .horizontal)).minX))
        }
    }
}

// MARK: Timeline

/// Virtualized in both directions, so hundreds of channels and thousands of programs stay smooth:
/// - One two-way `ScrollView` around a `LazyVStack`, so only the channel rows on screen exist.
/// - Each row draws only the programs near the visible stretch of time. That stretch moves in half-hour steps,
///   so horizontal scrolling re-renders rows a few times per screen width, not on every frame.
/// - The pinned channel column and corner button follow the scroll with `visualEffect`, at render time.
private struct TimelineGuide<Header: View>: View {
    let channels: [Channel]
    let now: Double
    let windowStart: Double
    let playingKey: String?
    @Binding var reveal: String?
    @Binding var savedZoom: Double
    let onTune: (Channel) -> Void
    let onInspect: (Channel, Program) -> Void
    let onShowChannelGrid: () -> Void
    let header: Header

    @State private var zoom: CGFloat
    @State private var position = ScrollPosition(edge: .top)
    /// The half hour at the leading edge of the viewport.
    @State private var page = 0
    @State private var viewport = CGSize(width: 400, height: 600)
    @State private var headerHeight: CGFloat = 0
    @State private var handle = ScrollHandle()
    @State private var pinch: PinchStart?
    /// 0…1: how far a pinch has gone past the smallest zoom, toward switching to the channel grid.
    @State private var overshoot: CGFloat = 0
    @State private var haptics = PinchHaptics()

    private struct PinchStart {
        let zoom: CGFloat
        let anchor: CGPoint
        let offset: CGPoint
    }

    init(
        channels: [Channel], now: Double, windowStart: Double, playingKey: String?,
        reveal: Binding<String?>, savedZoom: Binding<Double>,
        onTune: @escaping (Channel) -> Void, onInspect: @escaping (Channel, Program) -> Void,
        onShowChannelGrid: @escaping () -> Void, header: Header
    ) {
        self.channels = channels
        self.now = now
        self.windowStart = windowStart
        self.playingKey = playingKey
        _reveal = reveal
        _savedZoom = savedZoom
        self.onTune = onTune
        self.onInspect = onInspect
        self.onShowChannelGrid = onShowChannelGrid
        self.header = header
        _zoom = State(initialValue: min(GuideMetrics.maxZoom, max(GuideMetrics.minZoom, CGFloat(savedZoom.wrappedValue))))
    }

    var body: some View {
        let metrics = metrics(at: zoom)
        let visible = visibleRange(metrics)

        ScrollViewReader { proxy in
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    header
                        .containerRelativeFrame(.horizontal)
                        .stickyLeading()
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { headerHeight = $0 }
                    Section {
                        ForEach(channels) { channel in
                            GuideRow(
                                channel: channel,
                                metrics: metrics,
                                visible: visible,
                                now: now,
                                isPlaying: channel.key == playingKey,
                                onTune: { if handle.allowsTaps { onTune($0) } },
                                onInspect: { if handle.allowsTaps { onInspect($0, $1) } }
                            )
                            .id(channel.key)
                        }
                    } header: {
                        GuideRuler(metrics: metrics, now: now, isAwayFromNow: page > 0) {
                            withAnimation(.snappy) { position.scrollTo(x: 0) }
                        }
                    }
                }
                .frame(width: metrics.contentWidth, alignment: .leading)
                .padding(.bottom, 24)
                .background(ScrollViewBridge(handle: handle, locksDirection: true, onPinch: handlePinch))
            }
            .scrollPosition($position)
            .scrollIndicators(.hidden, axes: .horizontal)
            .onScrollGeometryChange(for: Int.self) { geometry in
                Int(max(0, geometry.contentOffset.x) / metrics.pageWidth)
            } action: { _, newPage in
                page = newPage
            }
            .onScrollGeometryChange(for: CGSize.self) { $0.containerSize } action: { _, size in
                viewport = size
            }
            .scaleEffect(1 - overshoot * 0.05)
            .opacity(1 - overshoot * 0.45)
            .onChange(of: reveal) { _, key in scroll(to: key, proxy) }
            .onAppear {
                // The guide is rebuilt after full screen or the channel grid; bring the playing channel back.
                let key = reveal
                Task { @MainActor in scroll(to: key, proxy) }
            }
            .accessibilityAction(named: "Show Channel Grid", onShowChannelGrid)
        }
    }

    private func metrics(at zoom: CGFloat) -> GuideMetrics {
        GuideMetrics(windowStart: windowStart, end: GuideMetrics.end(of: channels, from: windowStart), zoom: zoom)
    }

    private func scroll(to key: String?, _ proxy: ScrollViewProxy) {
        guard let key else { return }
        withAnimation(.snappy) { proxy.scrollTo(key, anchor: UnitPoint(x: 0, y: 0.4)) }
        reveal = nil
    }

    /// The stretch of time rows draw: what's on screen plus a half hour either side.
    private func visibleRange(_ metrics: GuideMetrics) -> ClosedRange<Double> {
        let pages = Int((viewport.width / metrics.pageWidth).rounded(.up))
        let from = metrics.windowStart + Double(page - 1) * GuideMetrics.halfHour
        let to = metrics.windowStart + Double(page + pages + 1) * GuideMetrics.halfHour
        return from...to
    }

    // MARK: Zoom

    private func handlePinch(_ event: PinchEvent) {
        switch event {
        case let .began(anchor):
            pinch = PinchStart(zoom: zoom, anchor: anchor, offset: handle.view?.contentOffset ?? .zero)
            haptics.began(at: zoom, in: handle.view)
        case let .changed(scale):
            guard let start = pinch else { return }
            let requested = start.zoom * scale
            overshoot = min(1, max(0, (GuideMetrics.minZoom - requested) / (GuideMetrics.minZoom * 0.35)))
            let clamped = min(GuideMetrics.maxZoom, max(GuideMetrics.minZoom, requested))
            haptics.zoomed(to: clamped, limited: requested < GuideMetrics.minZoom || requested > GuideMetrics.maxZoom)
            haptics.setArmed(overshoot >= 1)
            guard clamped != zoom else { return }
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                zoom = clamped
                position.scrollTo(point: offset(keeping: start, at: clamped))
            }
        case .ended:
            pinch = nil
            if overshoot >= 1 {
                overshoot = 0
                haptics.committed()
                onShowChannelGrid()
                return
            }
            withAnimation(.snappy) { overshoot = 0 }
            savedZoom = Double(zoom)
        }
    }

    /// The scroll offset that keeps whatever was under the fingers when the pinch began under them at `zoom`.
    private func offset(keeping start: PinchStart, at zoom: CGFloat) -> CGPoint {
        let before = metrics(at: start.zoom)
        let after = metrics(at: zoom)
        let column = GuideMetrics.channelColumn

        let contentX = start.offset.x + start.anchor.x
        let minutes = (contentX - column) / before.perMinute
        let x = column + minutes * after.perMinute - start.anchor.x

        let rowsTop = headerHeight + GuideMetrics.rulerHeight
        let contentY = start.offset.y + start.anchor.y
        var y = start.offset.y
        if contentY > rowsTop {
            let rows = (contentY - rowsTop) / before.rowPitch
            y = rowsTop + rows * after.rowPitch - start.anchor.y
        }

        let maxX = max(0, after.contentWidth - viewport.width)
        let maxY = max(0, rowsTop + CGFloat(channels.count) * after.rowPitch + 24 - viewport.height)
        return CGPoint(x: min(maxX, max(0, x)), y: min(maxY, max(0, y)))
    }
}

// MARK: Ruler

/// Half-hour marks across the top, pinned while the guide scrolls down, with a "Now" button in the corner.
private struct GuideRuler: View {
    let metrics: GuideMetrics
    let now: Double
    let isAwayFromNow: Bool
    let jumpToNow: () -> Void

    var body: some View {
        ZStack(alignment: .leading) {
            ForEach(Array(stride(from: metrics.windowStart, to: metrics.end, by: GuideMetrics.halfHour)), id: \.self) { slot in
                HStack(spacing: 6) {
                    Rectangle().fill(.white.opacity(0.25)).frame(width: 1, height: 12)
                    Text(GuideClock.time(slot))
                        .font(.caption.weight(.semibold).monospacedDigit())
                        .foregroundStyle(Theme.secondaryText)
                        .fixedSize()
                }
                .offset(x: GuideMetrics.channelColumn + metrics.x(slot))
            }
            Capsule()
                .fill(Theme.accent)
                .frame(width: 3, height: 14)
                .offset(x: GuideMetrics.channelColumn + metrics.x(now) - 1.5)

            Button(action: jumpToNow) {
                Text("Now")
                    .font(.caption.weight(.bold))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .foregroundStyle(isAwayFromNow ? Color.black : Theme.accent)
                    .background(Capsule().fill(isAwayFromNow ? Theme.accent : Theme.accent.opacity(0.18)))
            }
            .buttonStyle(.plain)
            .frame(width: GuideMetrics.channelColumn, height: GuideMetrics.rulerHeight)
            .background(Theme.background)
            .stickyLeading()
            .accessibilityLabel("Jump to now")
        }
        .frame(width: metrics.contentWidth, height: GuideMetrics.rulerHeight, alignment: .leading)
        .background(Theme.background)
        .overlay(alignment: .bottom) { Rectangle().fill(.white.opacity(0.08)).frame(height: 1) }
    }
}

// MARK: Rows

/// One channel: its tile, pinned on the left, and the programs in the visible stretch of time.
private struct GuideRow: View {
    let channel: Channel
    let metrics: GuideMetrics
    let visible: ClosedRange<Double>
    let now: Double
    let isPlaying: Bool
    let onTune: (Channel) -> Void
    let onInspect: (Channel, Program) -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            lane
                .offset(x: GuideMetrics.channelColumn)
            ChannelTile(channel: channel, height: metrics.rowHeight, isPlaying: isPlaying) { onTune(channel) }
                .padding(.leading, 8)
                .frame(width: GuideMetrics.channelColumn, height: metrics.rowPitch, alignment: .topLeading)
                .background(Theme.background)
                .stickyLeading()
        }
        .frame(width: metrics.contentWidth, height: metrics.rowPitch, alignment: .topLeading)
    }

    private var lane: some View {
        let inTimeline = channel.programs.contains { $0.end > metrics.windowStart && $0.start < metrics.end }
        return ZStack(alignment: .topLeading) {
            // Time already gone, dimmed, and the now line. Drawn per row so the line runs unbroken down the guide.
            Rectangle()
                .fill(.black.opacity(0.28))
                .frame(width: max(0, metrics.x(now)))
            if inTimeline {
                ForEach(programs) { program in
                    cell(program)
                }
            } else {
                Text("No listings")
                    .font(.caption)
                    .foregroundStyle(Theme.secondaryText)
                    .padding(.horizontal, 12)
                    .frame(width: max(0, metrics.timelineWidth - 4), height: metrics.rowHeight, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.white.opacity(0.04)))
            }
            Rectangle()
                .fill(Theme.accent)
                .frame(width: 2)
                .offset(x: metrics.x(now) - 1)
                .allowsHitTesting(false)
        }
        .frame(width: metrics.timelineWidth, height: metrics.rowPitch, alignment: .topLeading)
    }

    /// Programs inside both the timeline and the stretch of time on screen.
    private var programs: [Program] {
        let from = max(visible.lowerBound, metrics.windowStart)
        let to = min(visible.upperBound, metrics.end)
        return channel.programs.filter { $0.end > from && $0.start < to }
    }

    private func cell(_ program: Program) -> some View {
        let start = max(program.start, metrics.windowStart)
        let end = min(program.end, metrics.end)
        let airing = program.start <= now && now < program.end
        return ProgramCell(
            program: program,
            width: max(4, metrics.x(end) - metrics.x(start) - 4),
            height: metrics.rowHeight,
            elapsed: airing ? max(0, metrics.x(now) - metrics.x(start)) : 0,
            airing: airing,
            playing: airing && isPlaying
        ) {
            if airing { onTune(channel) } else { onInspect(channel, program) }
        }
        .offset(x: metrics.x(start))
    }
}

/// A channel in the left column: its artwork and, when there's room, its name. Tap to watch.
private struct ChannelTile: View {
    let channel: Channel
    let height: CGFloat
    let isPlaying: Bool
    let action: () -> Void

    var body: some View {
        let artwork = min(48, max(24, height * 0.48))
        Button(action: action) {
            VStack(spacing: 4) {
                ChannelArtwork(channel: channel)
                    .frame(width: artwork, height: artwork)
                    .clipShape(RoundedRectangle(cornerRadius: artwork * 0.23, style: .continuous))
                if height >= 50 {
                    Text(channel.name)
                        .font(.caption2.weight(.semibold))
                        .lineLimit(1)
                        .foregroundStyle(isPlaying ? Theme.accent : .white.opacity(0.85))
                }
            }
            .padding(.horizontal, 4)
            .frame(width: 72, height: height)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(isPlaying ? Theme.accent.opacity(0.22) : .white.opacity(0.07))
            )
            .overlay {
                if isPlaying {
                    RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.accent, lineWidth: 1.5)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Channel \(channel.number), \(channel.name)\(isPlaying ? ", playing" : "")")
        .accessibilityHint("Watch live")
    }
}

/// The channel's logo, or its number when it has none.
private struct ChannelArtwork: View {
    let channel: Channel

    var body: some View {
        ZStack {
            Theme.placeholder
            if channel.avatarURL != nil {
                RemoteImage(path: channel.avatarURL)
            } else {
                Text("\(channel.number)")
                    .font(.caption.weight(.heavy).monospacedDigit())
                    .foregroundStyle(Theme.secondaryText)
            }
        }
    }
}

/// One program on the timeline, as wide as its running time. Taller rows give the title a second line.
private struct ProgramCell: View {
    let program: Program
    let width: CGFloat
    let height: CGFloat
    /// How much of the visible cell has already aired, shaded in.
    let elapsed: CGFloat
    let airing: Bool
    let playing: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 3) {
                if width > 44 {
                    Text(program.title ?? "Untitled")
                        .font(height > 84 ? .headline : .subheadline.weight(.semibold))
                        .foregroundStyle(playing ? Theme.accent : .white)
                        .lineLimit(height > 84 ? 2 : 1)
                    if height >= 48 {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(Theme.secondaryText)
                            .lineLimit(1)
                    }
                }
            }
            .padding(.horizontal, width < 90 ? 6 : 10)
            .frame(width: width, height: height, alignment: .leading)
            .background {
                ZStack(alignment: .leading) {
                    Rectangle().fill(.white.opacity(airing ? 0.09 : 0.05))
                    if airing {
                        Rectangle().fill(.white.opacity(0.08)).frame(width: min(width, elapsed))
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
            .overlay {
                if playing {
                    RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.accent, lineWidth: 1.5)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(program.title ?? "Untitled"), \(detail)")
        .accessibilityHint(airing ? "Watch live" : "Show details")
    }

    private var detail: String {
        if airing { return "Until \(GuideClock.time(program.end))" }
        return [GuideClock.time(program.start), program.subtitle].compactMap { $0 }.joined(separator: " · ")
    }
}

// MARK: Channel grid

/// Zoomed all the way out: every channel as a tile with what it's airing now, no timeline.
private struct ChannelGridGuide<Header: View>: View {
    let channels: [Channel]
    let now: Double
    let playingKey: String?
    @Binding var reveal: String?
    let onTune: (Channel) -> Void
    let onShowTimeline: () -> Void
    let header: Header

    @State private var handle = ScrollHandle()
    /// Live pinch-out progress toward the timeline, for a little stretch as feedback.
    @State private var stretch: CGFloat = 0
    @State private var haptics = PinchHaptics()

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 0) {
                    header
                    HStack {
                        Text("All Channels").font(.headline)
                        Spacer()
                        Button(action: onShowTimeline) {
                            Label("Guide", systemImage: "calendar.day.timeline.left")
                                .font(.subheadline.weight(.semibold))
                        }
                    }
                    .padding(.horizontal, Theme.pageInset)
                    .padding(.vertical, 10)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 10)], alignment: .leading, spacing: 14) {
                        ForEach(channels) { channel in
                            ChannelCard(channel: channel, program: channel.airing(at: now), now: now, isPlaying: channel.key == playingKey) {
                                if handle.allowsTaps { onTune(channel) }
                            }
                            .id(channel.key)
                        }
                    }
                    .padding(.horizontal, Theme.pageInset)
                }
                .padding(.bottom, 24)
                .background(ScrollViewBridge(handle: handle, onPinch: handlePinch))
            }
            .scaleEffect(1 + stretch * 0.04)
            .onChange(of: reveal) { _, key in scroll(to: key, proxy) }
            .onAppear {
                let key = reveal
                Task { @MainActor in scroll(to: key, proxy) }
            }
        }
    }

    private func scroll(to key: String?, _ proxy: ScrollViewProxy) {
        guard let key else { return }
        withAnimation(.snappy) { proxy.scrollTo(key, anchor: .center) }
        reveal = nil
    }

    private func handlePinch(_ event: PinchEvent) {
        switch event {
        case .began:
            haptics.began(at: 1, in: handle.view)
        case let .changed(scale):
            stretch = min(1, max(0, (scale - 1) / 0.35))
            haptics.setArmed(stretch >= 1)
        case .ended:
            if stretch >= 1 {
                stretch = 0
                haptics.committed()
                onShowTimeline()
            } else {
                withAnimation(.snappy) { stretch = 0 }
            }
        }
    }
}

/// A channel in the grid: what it's airing now (or its logo), how far along, and its name.
private struct ChannelCard: View {
    let channel: Channel
    let program: Program?
    let now: Double
    let isPlaying: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 6) {
                ZStack {
                    Theme.placeholder
                    if let thumbnail = program?.thumbnailURL {
                        RemoteImage(path: thumbnail)
                    } else {
                        ChannelArtwork(channel: channel).padding(18)
                    }
                }
                .aspectRatio(16 / 11, contentMode: .fit)
                .overlay(alignment: .topLeading) {
                    if program?.thumbnailURL != nil, channel.avatarURL != nil {
                        ChannelArtwork(channel: channel)
                            .frame(width: 24, height: 24)
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                            .padding(6)
                    }
                }
                .overlay(alignment: .bottom) {
                    if let program {
                        ProgressBar(value: program.progress(at: now), height: 3).padding(6)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(isPlaying ? Theme.accent : .white.opacity(0.08), lineWidth: isPlaying ? 2 : 1)
                }

                VStack(alignment: .leading, spacing: 1) {
                    Text("\(channel.number) \(channel.name)")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(isPlaying ? Theme.accent : Theme.secondaryText)
                        .lineLimit(1)
                    Text(program?.title ?? "No listings")
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Channel \(channel.number), \(channel.name), \(program?.title ?? "no listings")\(isPlaying ? ", playing" : "")")
        .accessibilityHint("Watch live")
    }
}
