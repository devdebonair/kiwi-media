import SwiftUI

/// A row of cards in the style of Netflix's 2025 TV app: posters sit side by side, and the one in focus opens up
/// into a wide card showing the title's artwork. The card in focus stays at the left edge and the row moves
/// under it; the card that loses focus slides away *under* the one opening, in either direction, and cards
/// that have moved past the edge fade out. What the card is (year, rating, a line or two of story) appears
/// under the row in focus, so the page needs no billboard that follows focus around.
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

    /// How the row and its cards move when focus changes. Shared, so the slide and the card resizing land together.
    static let move = Animation.smooth(duration: 0.65)

    /// The card in focus, when it's in this row.
    private var focusedItem: TileItem? {
        guard let key = focus.wrappedValue, key.hasPrefix(shelf.id + "|") else { return nil }
        return shelf.items.first { Self.focusKey(shelf, $0) == key }
    }

    var body: some View {
        let focused = focusedItem
        VStack(alignment: .leading, spacing: 0) {
            Text(shelf.title)
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(focused != nil ? .white : .white.opacity(0.75))
                .shadow(color: .black.opacity(0.5), radius: 8)
                .padding(.leading, inset)
            ScrollViewReader { reader in
            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: shelf.style == .ranked ? 18 : Theme.shelfSpacing) {
                    ForEach(Array(shelf.items.enumerated()), id: \.element.id) { index, item in
                        Group {
                            switch shelf.style {
                            case .ranked: RankedCard(item: item, rank: index + 1)
                            case .poster: PosterCard(item: item)
                            case .landscape: LandscapeCard(item: item)
                            }
                        }
                        .focused(focus, equals: Self.focusKey(shelf, item))
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
                .scrollTargetLayout()
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
            if let focused {
                FocusedDetails(item: focused)
                    .padding(.horizontal, inset)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.3), value: focused?.id)
        .onChange(of: focused?.id) { _, new in
            guard let new else { return }
            if let old = lastFocused, old != new { handoff = old }
            lastFocused = new
            anchored = new
        }
        .focusSection()
    }

    static func focusKey(_ shelf: Shelf, _ item: TileItem) -> String { "\(shelf.id)|\(item.id)" }
}

/// Year, rating and kind, then a couple of lines of story: the focused card's facts under its row.
private struct FocusedDetails: View {
    let item: TileItem

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let metadata = item.metadata, !metadata.isEmpty {
                Text(metadata)
                    .font(.system(size: 23, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.85))
                    .lineLimit(1)
            }
            if let overview = item.overview ?? item.subtitle, !overview.isEmpty, item.metadata?.contains(overview) != true {
                Text(overview)
                    .font(.system(size: 23))
                    .foregroundStyle(Theme.secondaryText)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: 1100, alignment: .leading)
        .frame(height: 84, alignment: .topLeading)
    }
}

// MARK: - Cards

/// A poster that widens into the title's artwork while it has focus.
struct PosterCard: View {
    let item: TileItem

    @Environment(\.openItem) private var openItem

    var body: some View {
        Button {
            openItem(item)
        } label: {
            PosterCardLabel(item: item)
        }
        // The label draws its own ring and rounding, around whichever face is showing.
        .buttonStyle(FocusRingStyle(drawsFrame: false))
        .accessibilityLabel(item.title)
    }
}

private struct PosterCardLabel: View {
    let item: TileItem
    @Environment(\.isFocused) private var isFocused

    /// Wide artwork for the open card, sharp enough for a 4K screen.
    private var wideArt: String? {
        item.backdrop.map { $0.replacingOccurrences(of: "/w780/", with: "/w1280/") }
    }

    private var posterArt: String? { item.withSharpPoster.artwork }

    var body: some View {
        let open = isFocused && wideArt != nil
        // Each face is drawn at its own fixed size, so the card never visibly stretches: the wide face
        // fades in over the poster, and only the room the card takes up in the row changes, which slides
        // its neighbours along.
        ZStack(alignment: .topLeading) {
            poster
            if open {
                wide
                    // Out quickly, so a closing card's artwork doesn't hang over the posters beside it.
                    .transition(.asymmetric(insertion: .opacity.animation(.easeOut(duration: 0.3)),
                                            removal: .opacity.animation(.easeOut(duration: 0.15))))
            }
        }
        .frame(width: open ? Theme.openPosterSize.width : Theme.posterSize.width,
               height: Theme.posterSize.height, alignment: .topLeading)
        .animation(ShelfView.move, value: open)
    }

    private var poster: some View {
        ZStack(alignment: .bottomLeading) {
            Theme.placeholder
            Text(item.title)
                .font(.system(size: 26, weight: .semibold))
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.secondaryText)
                .padding(18)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            RemoteImage(path: posterArt)
            progress
        }
        .face(Theme.posterSize, ring: isFocused && wideArt == nil)
    }

    private var wide: some View {
        ZStack(alignment: .bottomLeading) {
            Theme.placeholder
            RemoteImage(path: wideArt)
            LinearGradient(colors: [.clear, .black.opacity(0.75)], startPoint: .center, endPoint: .bottom)
            Text(item.title)
                .font(.system(size: 30, weight: .bold))
                .lineLimit(2)
                .shadow(radius: 6)
                .padding(24)
                .padding(.bottom, item.progress == nil ? 0 : 14)
            progress
        }
        .face(Theme.openPosterSize, ring: true)
    }

    @ViewBuilder private var progress: some View {
        if let progress = item.progress {
            ProgressBar(value: progress, height: 6)
                .padding(.horizontal, 16)
                .padding(.bottom, 14)
        }
    }
}

private extension View {
    /// One face of a poster card: a fixed size, rounded, with the focus ring when it's the face in focus.
    func face(_ size: CGSize, ring: Bool) -> some View {
        frame(width: size.width, height: size.height)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(.white, lineWidth: 5)
                    .padding(-8)
                    .opacity(ring ? 1 : 0)
                    .animation(.easeOut(duration: 0.25), value: ring)
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

/// Netflix's focus treatment: a white ring and a small lift, instead of the system's tilting card.
struct FocusRingStyle: ButtonStyle {
    var cornerRadius: CGFloat = 12
    /// Whether to round the label and ring it; off when the label does that itself.
    var drawsFrame = true

    func makeBody(configuration: Configuration) -> some View {
        RingBody(configuration: configuration, cornerRadius: cornerRadius, drawsFrame: drawsFrame)
    }

    private struct RingBody: View {
        let configuration: ButtonStyleConfiguration
        let cornerRadius: CGFloat
        let drawsFrame: Bool
        @Environment(\.isFocused) private var isFocused

        var body: some View {
            framed
                .scaleEffect(configuration.isPressed ? 0.97 : (isFocused ? 1.03 : 1))
                .shadow(color: .black.opacity(isFocused ? 0.55 : 0), radius: 20, y: 12)
                .animation(.easeOut(duration: 0.25), value: isFocused)
        }

        @ViewBuilder private var framed: some View {
            if drawsFrame {
                configuration.label
                    .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: cornerRadius + 4, style: .continuous)
                            .strokeBorder(.white, lineWidth: 5)
                            .padding(-8)
                            .opacity(isFocused ? 1 : 0)
                    }
            } else {
                configuration.label
            }
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
