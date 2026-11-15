import SwiftUI

/// A row of cards. Poster rows work like Netflix's TV app (see `StageShelf`); episode, video and Top 10 rows
/// scroll, with the card in focus held at the left edge. What the card in focus is (year, rating, a line or two
/// of story) appears under its row, so the page needs no billboard that follows focus around.
struct ShelfView: View {
    let shelf: Shelf
    var focus: FocusState<String?>.Binding
    /// Space before the first card. Pages that run their rows to the screen's edges pass the safe-area margin.
    var inset: CGFloat = 0

    /// The card held at the left edge.
    @State private var anchored: String?
    /// The card that just lost focus, kept above its other neighbours while the row moves.
    @State private var handoff: String?
    /// The last card in this row to have focus.
    @State private var lastFocused: String?
    /// The card described under the row, and which side its text comes in from (1 right, -1 left, 0 neither).
    @State private var described: TileItem?
    @State private var detailsDirection: CGFloat = 0
    /// How far along the row artwork loads: a few cards past the furthest one that has come on screen.
    @State private var reach = 8

    /// How the row and its cards move when focus changes. Shared, so the slide and the card resizing land together.
    static let move = Animation.smooth(duration: 0.65)

    /// The card in focus, when it's in this row.
    private var focusedItem: TileItem? {
        guard let key = focus.wrappedValue, key.hasPrefix(shelf.id + "|") else { return nil }
        return shelf.items.first { Self.focusKey(shelf, $0) == key }
    }

    var body: some View {
        if shelf.style == .poster {
            StageShelf(shelf: shelf, focus: focus, inset: inset)
        } else {
            scrolling
        }
    }

    private var scrolling: some View {
        let focused = focusedItem
        return VStack(alignment: .leading, spacing: 0) {
            Text(shelf.title)
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(focused != nil ? .white : .white.opacity(0.75))
                .shadow(color: .black.opacity(0.5), radius: 8)
                .padding(.leading, inset)
            ScrollViewReader { reader in
            ScrollView(.horizontal) {
                // Not lazy: a lazy row shifts its scroll position when a card before the visible ones opens,
                // which makes the row jump before it slides. Cards past `reach` don't load their artwork yet.
                HStack(alignment: .top, spacing: shelf.style == .ranked ? 18 : Theme.shelfSpacing) {
                    ForEach(Array(shelf.items.enumerated()), id: \.element.id) { index, item in
                        Group {
                            switch shelf.style {
                            case .ranked: RankedCard(item: item, rank: index + 1)
                            case .poster: EmptyView()
                            case .landscape: LandscapeCard(item: item)
                            }
                        }
                        .focused(focus, equals: Self.focusKey(shelf, item))
                        .environment(\.loadsRemoteImages, index < reach)
                        .onScrollVisibilityChange(threshold: 0.01) { visible in
                            if visible, index + 5 > reach { reach = index + 5 }
                        }
                        // The card opening covers the one closing, which moves along with the row underneath it.
                        .zIndex(item.id == focused?.id ? 2 : (item.id == handoff ? 1 : 0))
                        // Cards that have moved past the left edge fade out as they go (and back in as they return).
                        // Faded while drawing, so they can still take focus.
                        .visualEffect { [inset] content, proxy in
                            let x = proxy.frame(in: .global).minX
                            // Clear once a card has gone a full poster's width past the edge; solid while it's
                            // within about half a poster of it.
                            return content.opacity(min(1, max(0, (x - inset + 330) / 190)))
                        }
                    }
                }
                .padding(.vertical, 22)
            }
            // A content margin rather than padding, so the card held at the leading edge sits at the page margin.
            .contentMargins(.horizontal, inset, for: .scrollContent)
            .scrollClipDisabled()
            .onChange(of: anchored) { _, id in
                guard let id else { return }
                withAnimation(Self.move) { reader.scrollTo(id, anchor: .leading) }
            }
            }

            // What the card in focus is, under its row.
            SlidingDetails(item: described, token: described?.id, direction: detailsDirection)
                .padding(.horizontal, inset)
        }
        .animation(.easeOut(duration: 0.3), value: focused?.id)
        .onChange(of: focused?.id) { _, new in
            guard let new else {
                withAnimation(.easeOut(duration: 0.3)) { described = nil }
                return
            }
            // The text comes in from the side the row is moving toward; it just fades when focus first lands here.
            detailsDirection = 0
            if let old = lastFocused, old != new {
                handoff = old
                if described != nil,
                   let from = shelf.items.firstIndex(where: { $0.id == old }),
                   let to = shelf.items.firstIndex(where: { $0.id == new }) {
                    detailsDirection = to > from ? 1 : -1
                }
            }
            lastFocused = new
            anchored = new
            withAnimation(Self.move) { described = focused }
        }
        .focusSection()
    }

    static func focusKey(_ shelf: Shelf, _ item: TileItem) -> String { "\(shelf.id)|\(item.id)" }
}

/// Year, rating and kind, then the story in full: the focused card's facts under its row.
private struct FocusedDetails: View {
    let item: TileItem

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let metadata = item.metadata, !metadata.isEmpty {
                Text(metadata)
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.85))
                    .lineLimit(1)
            }
            if let overview = item.overview ?? item.subtitle, !overview.isEmpty, item.metadata?.contains(overview) != true {
                Text(overview)
                    .font(.system(size: 28))
                    .lineSpacing(4)
                    .foregroundStyle(Theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: 1500, alignment: .leading)
        // Room for the facts and three lines of story, so most titles don't move the rows below; longer
        // stories take the space they need.
        .frame(minHeight: 164, alignment: .topLeading)
    }
}

/// The details under a row. When the row moves to another card, the new text fades in while sliding a short
/// way from the side the card came from; the old text fades out quickly underneath.
private struct SlidingDetails<Token: Hashable>: View {
    let item: TileItem?
    let token: Token
    let direction: CGFloat

    var body: some View {
        ZStack(alignment: .topLeading) {
            if let item {
                FocusedDetails(item: item)
                    .id(token)
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .offset(x: direction * 40)),
                        removal: .opacity.animation(.easeOut(duration: 0.12))
                    ))
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

// MARK: - Cards

/// A poster row the way Netflix's TV app does it. One wide card, the stage, sits still on top of the row and
/// shows the title in focus. The posters run behind it with a gap reserved where it sits; moving left or right
/// slides the whole row one place, so the next poster goes in under the stage while the stage's artwork fades
/// to the new title. A sliver of the previous poster shows
/// to the stage's left. Long rows wrap around, so there's no first or last poster.
///
/// The row is a single focus target: the remote's left and right move the row, not the focus.
private struct StageShelf: View {
    let shelf: Shelf
    var focus: FocusState<String?>.Binding
    let inset: CGFloat

    @Environment(\.openItem) private var openItem
    /// Which poster is on the stage, counted along the row without wrapping (so it can go past either end).
    @State private var cursor = 0

    /// How the row moves a place: off quickly, then settling, so posters snap into position.
    private static let slide = Animation.timingCurve(0.16, 0.9, 0.3, 1, duration: 0.5)

    /// How many times the row has moved, either way.
    @State private var moves = 0
    /// Which way the row last moved: 1 when the title came from the right, -1 from the left, 0 not yet.
    @State private var direction: CGFloat = 0

    private var key: String { "\(shelf.id)|stage" }
    private var isFocused: Bool { focus.wrappedValue == key }
    /// Short rows stop at their ends: wrapping would show the same poster twice at once.
    private var loops: Bool { shelf.items.count >= 8 }
    private var step: CGFloat { Theme.posterSize.width + Theme.shelfSpacing }

    private func item(_ place: Int) -> TileItem {
        let count = shelf.items.count
        return shelf.items[((place % count) + count) % count]
    }

    /// The places drawn: two behind the stage's left edge to a few past the right edge of the screen.
    private var places: [Int] {
        let range = (cursor - 2)...(cursor + 7)
        return loops ? Array(range) : range.filter { shelf.items.indices.contains($0) }
    }

    /// Where a poster sits: in line up to the stage, then past the gap the stage takes up while the row has focus.
    private func position(_ place: Int) -> CGFloat {
        let offset = place - cursor
        if offset <= 0 { return inset + CGFloat(offset) * step }
        let gap = isFocused ? Theme.openPosterSize.width + Theme.shelfSpacing : step
        return inset + gap + CGFloat(offset - 1) * step
    }

    var body: some View {
        let current = item(cursor)
        VStack(alignment: .leading, spacing: 0) {
            Text(shelf.title)
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(isFocused ? .white : .white.opacity(0.75))
                .shadow(color: .black.opacity(0.5), radius: 8)
                .padding(.leading, inset)
            ZStack(alignment: .topLeading) {
                ForEach(places, id: \.self) { place in
                    StagePoster(item: item(place))
                        .offset(x: position(place))
                        .transition(.identity)
                }
                Button {
                    openItem(current)
                } label: {
                    StageCard(item: current, next: item(cursor + 1), previous: item(cursor - 1), cursor: cursor, moves: moves, direction: direction)
                }
                .buttonStyle(StageButtonStyle())
                .focused(focus, equals: key)
                .onMoveCommand(perform: move)
                .accessibilityLabel(current.title)
                .padding(.leading, inset)
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .frame(height: Theme.posterSize.height, alignment: .topLeading)
            .padding(.vertical, 22)

            SlidingDetails(item: isFocused ? current : nil, token: moves, direction: direction)
                .padding(.horizontal, inset)
        }
        .animation(ShelfView.move, value: isFocused)
        // The text just fades in when focus next lands on this row.
        .onChange(of: isFocused) { _, focused in
            if !focused { direction = 0 }
        }
        .focusSection()
    }

    private func move(_ command: MoveCommandDirection) {
        let change: Int
        switch command {
        case .left: change = -1
        case .right: change = 1
        default: return
        }
        let target = cursor + change
        guard loops || shelf.items.indices.contains(target) else { return }
        direction = CGFloat(change)
        withAnimation(Self.slide) {
            cursor = target
            moves += 1
        }
    }
}

/// A poster in the row behind the stage.
private struct StagePoster: View {
    let item: TileItem

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Theme.placeholder
            Text(item.title)
                .font(.system(size: 26, weight: .semibold))
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.secondaryText)
                .padding(18)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            RemoteImage(path: item.withSharpPoster.artwork)
            if let progress = item.progress {
                ProgressBar(value: progress, height: 6)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 14)
            }
        }
        .frame(width: Theme.posterSize.width, height: Theme.posterSize.height)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// The wide card that stays put over a poster row, showing the title in focus.
private struct StageCard: View {
    let item: TileItem
    let next: TileItem
    let previous: TileItem
    let cursor: Int
    /// How many times the row has moved; newer artwork is drawn above older.
    let moves: Int
    /// Which side the title came from: 1 right, -1 left, 0 neither.
    let direction: CGFloat

    @Environment(APIClient.self) private var api
    @Environment(\.isFocused) private var isFocused

    /// How far the artwork slides in, matching the text under the row.
    private static let slide: CGFloat = 40

    /// Wide artwork, sharp enough for a 4K screen; the poster when a title has none.
    private static func art(_ item: TileItem) -> String? {
        item.backdrop.map { $0.replacingOccurrences(of: "/w780/", with: "/w1280/") } ?? item.withSharpPoster.artwork
    }

    var body: some View {
        let size = Theme.openPosterSize
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        ZStack(alignment: .bottomLeading) {
            Theme.placeholder
            // The neighbours' artwork, fetched ahead so the next move fades straight to it.
            RemoteImage(path: Self.art(next)).frame(width: 1, height: 1).opacity(0)
            RemoteImage(path: Self.art(previous)).frame(width: 1, height: 1).opacity(0)
            // A cross fade: the new artwork fades in over the old, which stays solid underneath until it's
            // covered, so the card never dims in between. Like the text under the row, it slides a short way in
            // from the side its title came from; it's drawn a little wider than the card so that slide never
            // uncovers an edge.
            RemoteImage(path: Self.art(item))
                .frame(width: size.width + Self.slide * 2, height: size.height)
                .id(moves)
                .zIndex(Double(moves))
                .transition(.asymmetric(insertion: .opacity.combined(with: .offset(x: direction * Self.slide)),
                                        removal: .opacity.animation(.linear(duration: 0.01).delay(0.5))))
                .frame(width: size.width, height: size.height)
            LinearGradient(colors: [.clear, .black.opacity(0.75)], startPoint: .center, endPoint: .bottom)
            StageTitle(item: item)
                .padding(28)
                .padding(.bottom, item.progress == nil ? 0 : 14)
                .id(cursor)
                .transition(.opacity)
            if let progress = item.progress {
                ProgressBar(value: progress, height: 6)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 14)
            }
        }
        .frame(width: size.width, height: size.height)
        .clipShape(shape)
        .overlay { shape.strokeBorder(.white, lineWidth: 5) }
        // The neighbours' logos too, while the row has focus.
        .task(id: isFocused ? cursor : nil) {
            guard isFocused else { return }
            async let following = LogoStore.shared.image(for: next, api: api)
            async let preceding = LogoStore.shared.image(for: previous, api: api)
            _ = await (following, preceding)
        }
    }
}

/// The title over the wide card: its logo, as on the billboard, or its name when it has none. Nothing shows while
/// the logo is on its way, so the name doesn't flash up first; the neighbours' logos are fetched ahead, so moving
/// along a row rarely waits.
private struct StageTitle: View {
    let item: TileItem

    @Environment(APIClient.self) private var api
    @State private var logo: UIImage?
    @State private var settled: Bool

    init(item: TileItem) {
        self.item = item
        _settled = State(initialValue: LogoStore.shared.knownToHaveNone(item))
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let logo = logo ?? LogoStore.shared.cachedImage(for: item, api: api) {
                Image(uiImage: logo)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(maxWidth: 420, maxHeight: 150, alignment: .bottomLeading)
                    .shadow(color: .black.opacity(0.5), radius: 12)
            } else if settled {
                Text(item.title)
                    .font(.system(size: 30, weight: .bold))
                    .lineLimit(2)
                    .shadow(radius: 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .bottomLeading)
        .animation(.easeOut(duration: 0.2), value: settled)
        .task(id: item.id) {
            guard LogoStore.shared.cachedImage(for: item, api: api) == nil else { return }
            logo = await LogoStore.shared.image(for: item, api: api)
            settled = true
        }
    }
}

/// Shows the stage only while its row has focus. Faded while drawing rather than with `.opacity`, since a fully
/// transparent view can't take focus.
private struct StageButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        StageBody(configuration: configuration)
    }

    private struct StageBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isFocused) private var isFocused

        var body: some View {
            configuration.label
                .scaleEffect(configuration.isPressed ? 0.98 : 1)
                .shadow(color: .black.opacity(0.55), radius: 20, y: 12)
                .visualEffect { [isFocused] content, _ in content.opacity(isFocused ? 1 : 0) }
                .animation(.easeOut(duration: 0.3), value: isFocused)
        }
    }
}

/// A wide card for episodes, videos and live channels.
struct LandscapeCard: View {
    let item: TileItem

    @Environment(\.openItem) private var openItem

    var body: some View {
        Button {
            openItem(item)
        } label: {
            CardArtwork(item: item, size: Theme.landscapeSize, showsTitleFallback: true)
                .overlay(alignment: .bottomLeading) {
                    Text(item.title)
                        .font(.system(size: 24, weight: .semibold))
                        .lineLimit(1)
                        .shadow(color: .black, radius: 6)
                        .padding(.horizontal, 16)
                        .padding(.top, 30)
                        .padding(.bottom, item.progress == nil ? 14 : 30)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(LinearGradient(colors: [.clear, .black.opacity(0.75)], startPoint: .top, endPoint: .bottom))
                }
        }
        .buttonStyle(FocusRingStyle())
        .accessibilityLabel(item.title)
    }
}

/// A Top 10 card: a huge outlined rank number tucked behind the poster.
struct RankedCard: View {
    let item: TileItem
    let rank: Int

    @Environment(\.openItem) private var openItem

    var body: some View {
        HStack(alignment: .bottom, spacing: -34) {
            RankNumber(rank: rank, size: 380)
                .frame(width: rank >= 10 ? 370 : 225, alignment: .trailing)
            Button {
                openItem(item)
            } label: {
                CardArtwork(item: item.withSharpPoster, size: Theme.posterSize, showsTitleFallback: true)
            }
            .buttonStyle(FocusRingStyle())
            .accessibilityLabel("\(rank). \(item.title)")
        }
    }
}

/// Netflix's focus treatment: a white ring on the card's edge, instead of the system's tilting card. Nothing grows
/// past the card, so the gap to its neighbours stays the same in and out of focus.
struct FocusRingStyle: ButtonStyle {
    var cornerRadius: CGFloat = 12

    func makeBody(configuration: Configuration) -> some View {
        RingBody(configuration: configuration, cornerRadius: cornerRadius)
    }

    private struct RingBody: View {
        let configuration: ButtonStyleConfiguration
        let cornerRadius: CGFloat
        @Environment(\.isFocused) private var isFocused

        var body: some View {
            let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            configuration.label
                .clipShape(shape)
                .overlay {
                    shape.strokeBorder(.white, lineWidth: 5)
                        .opacity(isFocused ? 1 : 0)
                }
                .scaleEffect(configuration.isPressed ? 0.97 : 1)
                .shadow(color: .black.opacity(isFocused ? 0.55 : 0), radius: 20, y: 12)
                .animation(.easeOut(duration: 0.25), value: isFocused)
        }
    }
}

/// A rank drawn as a dark numeral with a light outline, like a streaming service's Top 10 row.
struct RankNumber: View {
    let rank: Int
    let size: CGFloat

    var body: some View {
        let text = Text("\(rank)").font(.system(size: size, weight: .black, design: .rounded))
        ZStack {
            ForEach(Array([(-2.0, -2.0), (2.0, -2.0), (-2.0, 2.0), (2.0, 2.0)].enumerated()), id: \.offset) { _, offset in
                text.foregroundStyle(.white.opacity(0.75)).offset(x: offset.0, y: offset.1)
            }
            text.foregroundStyle(Theme.background)
        }
        .fixedSize()
        .offset(y: size * 0.12)
        .accessibilityHidden(true)
    }
}

/// Card artwork with a progress bar, falling back to the title on a plain tile when there's no image.
struct CardArtwork: View {
    let item: TileItem
    let size: CGSize
    var showsTitleFallback = false

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Theme.placeholder
            if showsTitleFallback {
                Text(item.title)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(Theme.secondaryText)
                    .padding(20)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            RemoteImage(path: item.artwork)
            if case .tune = item.action {
                LiveBadge()
                    .padding(14)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            if let progress = item.progress {
                ProgressBar(value: progress, height: 6)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 14)
            }
        }
        .frame(width: size.width, height: size.height)
    }
}

struct LiveBadge: View {
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(.red).frame(width: 10, height: 10)
            Text("LIVE").font(.caption2.weight(.heavy))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Capsule().fill(.black.opacity(0.65)))
    }
}

extension TileItem {
    /// The same card with its poster at a size that stays sharp on a 4K screen (the server keeps w500 copies).
    var withSharpPoster: TileItem {
        var copy = self
        copy.artwork = artwork.map { $0.replacingOccurrences(of: "/w342/", with: "/w500/").replacingOccurrences(of: "/w185/", with: "/w500/") }
        return copy
    }
}
