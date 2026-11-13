import SwiftUI

/// Live TV: what every channel is airing now, with how far along it is and what's next. Tap to join live.
struct LiveScreen: View {
    @Environment(AppModel.self) private var app
    @State private var model = GuideModel()

    var body: some View {
        ScrollView(.vertical) {
            LazyVStack(alignment: .leading, spacing: 14) {
                if let (channel, program) = spotlight {
                    SpotlightCard(channel: channel, program: program, now: model.now)
                        .padding(.horizontal, Theme.pageInset)
                        .padding(.bottom, 8)
                }
                ForEach(model.channels) { channel in
                    if let program = channel.airing(at: model.now) {
                        ChannelRow(channel: channel, program: program, next: channel.upNext(at: model.now), now: model.now)
                            .padding(.horizontal, Theme.pageInset)
                    }
                }
            }
            .padding(.vertical, 8)
        }
        .background { TintedBackground(path: spotlight?.1.thumbnailURL) }
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
        .toolbar { ToolbarItem(placement: .topBarTrailing) { ProfileMenu() } }
        .refreshable { await model.refresh(app.api) }
        .task {
            if model.state == .loading { await model.refresh(app.api) }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                await model.tick(app.api)
            }
        }
    }

    /// The first movie or episode on air, for the big card at the top.
    private var spotlight: (Channel, Program)? {
        for channel in model.channels {
            if let program = channel.airing(at: model.now), program.catalog == true, program.thumbnailURL != nil {
                return (channel, program)
            }
        }
        return nil
    }
}

private struct SpotlightCard: View {
    let channel: Channel
    let program: Program
    let now: Double

    @Environment(AppModel.self) private var app

    var body: some View {
        Button {
            app.tune(channel.key)
        } label: {
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
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(.white.opacity(0.15)))
                .shadow(color: .black.opacity(0.5), radius: 20, y: 10)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Watch \(program.title ?? channel.name) live on \(channel.name)")
    }
}

private struct ChannelRow: View {
    let channel: Channel
    let program: Program
    let next: Program?
    let now: Double

    @Environment(AppModel.self) private var app

    var body: some View {
        Button {
            app.tune(channel.key)
        } label: {
            HStack(spacing: 12) {
                ZStack(alignment: .bottom) {
                    Theme.placeholder
                    RemoteImage(path: program.thumbnailURL ?? channel.avatarURL)
                    LiveBadge()
                        .padding(5)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    ProgressBar(value: program.progress(at: now), height: 3)
                }
                .frame(width: 136, height: 77)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text("\(channel.number)")
                            .font(.caption.weight(.heavy).monospacedDigit())
                            .foregroundStyle(Theme.accent)
                        Text(channel.name)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Theme.secondaryText)
                            .lineLimit(1)
                    }
                    Text(program.title ?? "Untitled")
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Text(timing)
                        .font(.caption)
                        .foregroundStyle(Theme.secondaryText)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white.opacity(0.06)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var timing: String {
        var parts = ["Until \(GuideClock.time(program.end))"]
        if let next { parts.append("Next: \(next.title ?? "Untitled")") }
        return parts.joined(separator: " · ")
    }
}
