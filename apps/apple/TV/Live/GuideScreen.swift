import SwiftUI

/// Live TV: every channel as a row of what's on now and next, sized by running time, under a billboard for
/// the program in focus. Selecting what's on now joins the channel live; a later program plays from the start.
struct GuideScreen: View {
    @Environment(AppModel.self) private var app
    @State private var model = GuideModel()
    @FocusState private var focusKey: String?
    @State private var shown: TileItem?

    /// Points per minute of running time.
    private let scale: CGFloat = 9
    private let channelColumn: CGFloat = 230

    var body: some View {
        ZStack {
            switch model.state {
            case .loading:
                ProgressView().controlSize(.large)
            case .empty:
                ContentUnavailableView("No channels yet", systemImage: "tv", description: Text("Channels appear once a tag, genre or library has at least three videos."))
            case let .failed(message):
                ContentUnavailableView("Couldn't load the guide", systemImage: "exclamationmark.triangle", description: Text(message))
            case .loaded:
                VStack(alignment: .leading, spacing: 20) {
                    if let item = shown ?? firstLive {
                        BillboardPanel(item: item)
                            .frame(height: 420)
                            .focusSection()
                    }
                    ScrollView(.vertical) {
                        // Not lazy, so the focus engine can move down to channels below the visible ones.
                        VStack(alignment: .leading, spacing: 14) {
                            ForEach(model.channels) { channel in
                                row(channel)
                            }
                        }
                        .padding(.vertical, 20)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background { TintedBackground(path: shown?.backdrop ?? shown?.artwork, height: 1100) }
        .onChange(of: focusKey) { _, key in
            guard let key, let item = item(forKey: key) else { return }
            withAnimation(.easeInOut(duration: 0.3)) { shown = item }
        }
        .task {
            if model.state == .loading { await model.refresh(app.api) }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                await model.tick(app.api)
            }
        }
    }

    private var firstLive: TileItem? {
        for channel in model.channels {
            if let program = channel.airing(at: model.now) { return TileItem(channel: channel, program: program, now: model.now) }
        }
        return nil
    }

    private func row(_ channel: Channel) -> some View {
        HStack(alignment: .center, spacing: 24) {
            ChannelBadge(channel: channel)
                .frame(width: channelColumn, alignment: .leading)
            ScrollView(.horizontal) {
                LazyHStack(spacing: 16) {
                    ForEach(upcoming(channel)) { program in
                        ProgramCell(
                            program: program,
                            isLive: program.start <= model.now && model.now < program.end,
                            now: model.now,
                            width: width(of: program)
                        ) {
                            if program.start <= model.now && model.now < program.end {
                                app.tune(channel.key)
                            } else {
                                app.play(program.assetId, startOver: true)
                            }
                        }
                        .focused($focusKey, equals: "\(channel.key)|\(program.id)")
                    }
                }
                .padding(.vertical, 12)
            }
            .scrollClipDisabled()
        }
        .focusSection()
    }

    /// What's airing now and the next few hours.
    private func upcoming(_ channel: Channel) -> [Program] {
        Array(channel.programs.filter { $0.end > model.now }.prefix(8))
    }

    /// The live program is as wide as its remaining time; later ones as wide as their running time.
    private func width(of program: Program) -> CGFloat {
        let minutes = (program.end - max(program.start, model.now)) / 60_000
        return min(1100, max(300, CGFloat(minutes) * scale))
    }

    private func item(forKey key: String) -> TileItem? {
        let parts = key.split(separator: "|", maxSplits: 1).map(String.init)
        guard parts.count == 2, let channel = model.channels.first(where: { $0.key == parts[0] }),
              let program = channel.programs.first(where: { $0.id == parts[1] })
        else { return nil }
        var item = TileItem(channel: channel, program: program, now: model.now)
        if program.start > model.now {
            item = TileItem(
                id: item.id, title: item.title,
                subtitle: item.subtitle, overview: program.subtitle,
                artwork: item.artwork, backdrop: item.backdrop,
                metadata: "\(GuideClock.time(program.start)) on \(channel.number)  \(channel.name)",
                detailRef: program.titleId,
                playAssetId: program.assetId,
                action: .play(assetId: program.assetId)
            )
        }
        return item
    }
}

struct ChannelBadge: View {
    let channel: Channel

    var body: some View {
        HStack(spacing: 16) {
            ZStack {
                Circle().fill(Theme.placeholder)
                if channel.avatarURL != nil {
                    RemoteImage(path: channel.avatarURL).clipShape(Circle())
                } else {
                    Image(systemName: channel.type == "custom" ? "square.stack.3d.up" : "tv")
                        .font(.title3)
                        .foregroundStyle(Theme.secondaryText)
                }
            }
            .frame(width: 64, height: 64)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(channel.number)")
                    .font(.caption.weight(.heavy).monospacedDigit())
                    .foregroundStyle(Theme.accent)
                Text(channel.name)
                    .font(.callout.weight(.semibold))
                    .lineLimit(2)
            }
        }
    }
}

private struct ProgramCell: View {
    let program: Program
    let isLive: Bool
    let now: Double
    let width: CGFloat
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .bottomLeading) {
                Theme.placeholder
                RemoteImage(path: program.thumbnailURL)
                    .opacity(0.45)
                LinearGradient(colors: [.black.opacity(0.2), .black.opacity(0.85)], startPoint: .top, endPoint: .bottom)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 10) {
                        if isLive { LiveBadge() }
                        Text(isLive ? "Until \(GuideClock.time(program.end))" : "\(GuideClock.time(program.start)) – \(GuideClock.time(program.end))")
                            .font(.caption.weight(.semibold).monospacedDigit())
                            .foregroundStyle(Theme.secondaryText)
                    }
                    Text(program.title ?? "Untitled")
                        .font(.callout.weight(.bold))
                        .lineLimit(1)
                    if let subtitle = program.subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(Theme.secondaryText)
                            .lineLimit(1)
                    }
                    if isLive {
                        ProgressBar(value: program.progress(at: now), height: 5)
                            .padding(.top, 4)
                    }
                }
                .padding(18)
            }
            .frame(width: width, height: 150)
        }
        .buttonStyle(.card)
    }
}
