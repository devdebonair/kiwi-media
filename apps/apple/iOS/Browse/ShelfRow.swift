import SwiftUI

/// A titled horizontal row of cards.
struct ShelfRow: View {
    let shelf: Shelf

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(shelf.title)
                .font(.title3.weight(.bold))
                .padding(.horizontal, Theme.pageInset)
            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: Theme.shelfSpacing) {
                    ForEach(Array(shelf.items.enumerated()), id: \.element.id) { index, item in
                        if shelf.style == .ranked {
                            RankedTile(item: item, rank: index + 1)
                        } else {
                            TileButton(item: item, style: shelf.style)
                        }
                    }
                }
                .scrollTargetLayout()
                .padding(.horizontal, Theme.pageInset)
            }
            .scrollIndicators(.hidden)
            .scrollTargetBehavior(.viewAligned)
        }
    }
}

struct TileButton: View {
    let item: TileItem
    let style: Shelf.Style

    @Environment(\.openItem) private var openItem

    private var size: CGSize { style == .landscape ? Theme.landscapeSize : Theme.posterSize }

    var body: some View {
        Button {
            openItem(item)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                TileArtwork(item: item, size: size)
                if style == .landscape {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)
                        if let subtitle = item.subtitle {
                            Text(subtitle)
                                .font(.caption)
                                .foregroundStyle(Theme.secondaryText)
                                .lineLimit(1)
                        }
                    }
                    .frame(width: size.width, alignment: .leading)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(item.title)
    }
}

/// Card artwork with a progress bar; shows the title on a plain tile when there's no image. With no `size`,
/// it fills whatever frame it's given (grids).
struct TileArtwork: View {
    let item: TileItem
    var size: CGSize?

    var body: some View {
        ZStack(alignment: .bottom) {
            Theme.placeholder
            Text(item.title)
                .font(.caption.weight(.semibold))
                .multilineTextAlignment(.center)
                .foregroundStyle(Theme.secondaryText)
                .padding(8)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            RemoteImage(path: item.artwork)
            if case .tune = item.action {
                LiveBadge()
                    .padding(6)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            if let progress = item.progress {
                ProgressBar(value: progress, height: 4)
                    .padding(.horizontal, 8)
                    .padding(.bottom, 8)
            }
        }
        .frame(width: size?.width, height: size?.height)
        .clipShape(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous))
    }
}

/// A Top 10 card: a big outlined rank number tucked behind the poster.
struct RankedTile: View {
    let item: TileItem
    let rank: Int

    @Environment(\.openItem) private var openItem

    var body: some View {
        Button {
            openItem(item)
        } label: {
            HStack(alignment: .bottom, spacing: -16) {
                RankNumber(rank: rank, size: 128)
                    .frame(width: rank >= 10 ? 120 : 72, alignment: .trailing)
                TileArtwork(item: item, size: Theme.posterSize)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(rank). \(item.title)")
    }
}

/// A rank drawn as a dark numeral with a light outline.
struct RankNumber: View {
    let rank: Int
    let size: CGFloat

    var body: some View {
        let text = Text("\(rank)").font(.system(size: size, weight: .black, design: .rounded))
        ZStack {
            ForEach(Array([(-1.5, -1.5), (1.5, -1.5), (-1.5, 1.5), (1.5, 1.5)].enumerated()), id: \.offset) { _, offset in
                text.foregroundStyle(.white.opacity(0.8)).offset(x: offset.0, y: offset.1)
            }
            text.foregroundStyle(Theme.background)
        }
        .fixedSize()
        .offset(y: size * 0.13)
        .accessibilityHidden(true)
    }
}

struct LiveBadge: View {
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(.red).frame(width: 6, height: 6)
            Text("LIVE").font(.system(size: 10, weight: .heavy))
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Capsule().fill(.black.opacity(0.65)))
        .foregroundStyle(.white)
    }
}
