import SwiftUI

/// A horizontal row of cards with a heading.
struct ShelfView: View {
    let shelf: Shelf
    var focus: FocusState<String?>.Binding

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(shelf.title)
                .font(.title3.weight(.bold))
            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: shelf.style == .ranked ? 24 : Theme.shelfSpacing) {
                    ForEach(Array(shelf.items.enumerated()), id: \.element.id) { index, item in
                        if shelf.style == .ranked {
                            RankedCard(item: item, rank: index + 1, focusKey: Self.focusKey(shelf, item), focus: focus)
                        } else {
                            TileCard(item: item, style: shelf.style, focusKey: Self.focusKey(shelf, item), focus: focus)
                        }
                    }
                }
                .padding(.vertical, 24)
            }
            .scrollClipDisabled()
        }
        .focusSection()
    }

    static func focusKey(_ shelf: Shelf, _ item: TileItem) -> String { "\(shelf.id)|\(item.id)" }
}

struct TileCard: View {
    let item: TileItem
    let style: Shelf.Style
    let focusKey: String
    var focus: FocusState<String?>.Binding

    @Environment(\.openItem) private var openItem

    private var size: CGSize { style == .landscape ? Theme.landscapeSize : Theme.posterSize }
    private var isFocused: Bool { focus.wrappedValue == focusKey }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Button {
                openItem(item)
            } label: {
                CardArtwork(item: item, size: size, showsTitleFallback: true)
            }
            .buttonStyle(.card)
            .focused(focus, equals: focusKey)

            if style == .landscape {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title)
                        .font(.callout.weight(.medium))
                        .lineLimit(1)
                    if let subtitle = item.subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(Theme.secondaryText)
                            .lineLimit(1)
                    }
                }
                .frame(width: size.width, alignment: .leading)
                .opacity(isFocused ? 1 : 0.7)
                .offset(y: isFocused ? 10 : 0)
                .animation(.easeOut(duration: 0.2), value: isFocused)
            }
        }
    }
}

/// A Top 10 card: a huge outlined rank number tucked behind the poster.
struct RankedCard: View {
    let item: TileItem
    let rank: Int
    let focusKey: String
    var focus: FocusState<String?>.Binding

    @Environment(\.openItem) private var openItem

    var body: some View {
        HStack(alignment: .bottom, spacing: -38) {
            RankNumber(rank: rank, size: 300)
                .frame(width: rank >= 10 ? 270 : 170, alignment: .trailing)
            Button {
                openItem(item)
            } label: {
                CardArtwork(item: item, size: Theme.posterSize, showsTitleFallback: true)
            }
            .buttonStyle(.card)
            .focused(focus, equals: focusKey)
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
