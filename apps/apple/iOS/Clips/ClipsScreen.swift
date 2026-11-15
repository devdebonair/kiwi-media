import AVFoundation
import SwiftUI
import UIKit

/// Kiwi's Shorts as a full-screen vertical feed, like Netflix's Clips: one video per page, snapping as you
/// swipe, starting muted. The side rail holds mute and the like button (tap again to like more, up to five;
/// double-tap the video to like). More clips load as you near the end.
struct ClipsScreen: View {
    @Environment(AppModel.self) private var app
    @State private var clips: [Asset] = []
    @State private var activeID: String?
    @State private var muted = true
    @State private var state: LoadState = .loading
    @State private var exhausted = false

    private enum LoadState { case loading, loaded, empty }

    var body: some View {
        GeometryReader { geometry in
            ScrollView(.vertical) {
                LazyVStack(spacing: 0) {
                    ForEach(clips) { clip in
                        ClipPage(clip: clip, isActive: activeID == clip.id, muted: $muted)
                            .frame(width: geometry.size.width, height: geometry.size.height)
                            .onAppear {
                                if clip.id == clips.suffix(3).first?.id { Task { await loadMore() } }
                            }
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
            .scrollPosition(id: $activeID)
            .scrollIndicators(.hidden)
        }
        .ignoresSafeArea()
        .background(Color.black)
        .overlay {
            switch state {
            case .loading: ProgressView().controlSize(.large).tint(.white)
            case .empty:
                ContentUnavailableView("No clips yet", systemImage: "play.square.stack", description: Text("Short library videos show up here."))
            case .loaded: EmptyView()
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task {
            if clips.isEmpty { await loadMore() }
        }
    }

    private func loadMore() async {
        guard !exhausted else { return }
        let page = (try? await app.api.shorts(limit: 20, offset: clips.count)) ?? []
        let known = Set(clips.map(\.id))
        clips += page.filter { !known.contains($0.id) }
        exhausted = page.count < 20
        if activeID == nil { activeID = clips.first?.id }
        state = clips.isEmpty ? .empty : .loaded
    }
}

private struct ClipPage: View {
    let clip: Asset
    let isActive: Bool
    @Binding var muted: Bool

    @Environment(AppModel.self) private var app
    @State private var player = ClipPlayer()
    @State private var myLikes: Int
    @State private var likeCount: Int
    @State private var hearts = 0

    init(clip: Asset, isActive: Bool, muted: Binding<Bool>) {
        self.clip = clip
        self.isActive = isActive
        _muted = muted
        _myLikes = State(initialValue: clip.myLikes)
        _likeCount = State(initialValue: clip.likeCount)
    }

    var body: some View {
        ZStack {
            RemoteImage(path: clip.thumbnailURL)
            if let avPlayer = player.player {
                PlayerLayerView(player: avPlayer)
                    .transition(.opacity)
            }
            LinearGradient(colors: [.black.opacity(0.35), .clear, .clear, .black.opacity(0.75)], startPoint: .top, endPoint: .bottom)
                .allowsHitTesting(false)
            if player.isPaused {
                Image(systemName: "play.fill")
                    .font(.system(size: 56))
                    .foregroundStyle(.white.opacity(0.85))
                    .shadow(radius: 10)
                    .allowsHitTesting(false)
            }
            HeartBurst(trigger: hearts)
                .allowsHitTesting(false)
        }
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { Task { await like() } }
        .onTapGesture { player.togglePause() }
        .overlay(alignment: .bottomLeading) { info }
        .overlay(alignment: .bottomTrailing) { rail }
        .onChange(of: isActive, initial: true) { _, active in
            if active { player.start(clip, api: app.api, muted: muted) } else { player.stop() }
        }
        .onChange(of: muted) { _, value in player.setMuted(value) }
        .onDisappear { player.stop() }
    }

    private var info: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(clip.catalog?.title ?? clip.displayTitle)
                .font(.headline)
                .lineLimit(2)
            let tags = clip.topics.prefix(3).map(\.name)
            if !tags.isEmpty {
                Text(tags.joined(separator: " • "))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.85))
            }
            HStack(spacing: 10) {
                if let duration = clip.durationMs { Label(TileItem.duration(duration), systemImage: "clock") }
                if clip.viewCount > 0 { Label("\(clip.viewCount)", systemImage: "eye") }
            }
            .font(.caption)
            .foregroundStyle(.white.opacity(0.7))
        }
        .foregroundStyle(.white)
        .shadow(color: .black.opacity(0.5), radius: 6)
        .padding(.leading, 16)
        .padding(.trailing, 90)
        .padding(.bottom, 110)
    }

    private var rail: some View {
        VStack(spacing: 18) {
            RailButton(systemImage: muted ? "speaker.slash.fill" : "speaker.wave.2.fill", label: muted ? "Unmute" : "Mute") {
                muted.toggle()
            }
            LikeButton(level: myLikes, compact: true) {
                Task { await like() }
            }
            .contextMenu {
                if myLikes > 0 {
                    Button("Remove Like", systemImage: "heart.slash") { Task { await setLikes(0) } }
                }
            }
        }
        .padding(.trailing, 14)
        .padding(.bottom, 120)
    }

    /// One more like, up to five. At five, the hearts still burst but nothing changes, like the web.
    private func like() async {
        hearts += 1
        guard myLikes < LikeLevel.maximum else { return }
        await setLikes(myLikes + 1)
    }

    private func setLikes(_ level: Int) async {
        let previous = myLikes
        myLikes = level
        do {
            let result = try await app.api.setLikes(clip.id, count: level)
            myLikes = result.myLikes ?? level
            likeCount = result.likeCount ?? likeCount
        } catch {
            myLikes = previous
        }
    }
}

private struct RailButton: View {
    let systemImage: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 20, weight: .semibold))
                .frame(width: 50, height: 50)
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel(label)
    }
}
