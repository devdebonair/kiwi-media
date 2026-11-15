import AVFoundation
import SwiftUI
import UIKit

/// Plays one clip on a loop. Files AVPlayer can open are played as they are; anything else goes through the
/// server's HLS repackage, the same planner the main player uses.
@Observable
final class ClipPlayer {
    private(set) var player: AVPlayer?
    private(set) var isPaused = false

    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var loopObserver: (any NSObjectProtocol)?
    @ObservationIgnored private var viewed = false

    func start(_ clip: Asset, api: APIClient, muted: Bool) {
        stop()
        task = Task {
            guard let url = await Self.url(for: clip, api: api), !Task.isCancelled else { return }
            let item = AVPlayerItem(asset: AVURLAsset(url: url, options: [AVURLAssetHTTPCookiesKey: api.cookies()]))
            let player = AVPlayer(playerItem: item)
            player.isMuted = muted
            player.actionAtItemEnd = .none
            loopObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak player] _ in
                Task { @MainActor in
                    player?.seek(to: .zero)
                    player?.play()
                }
            }
            withAnimation(.easeIn(duration: 0.25)) { self.player = player }
            isPaused = false
            player.play()
            if !viewed {
                viewed = true
                let session = UUID().uuidString
                Task { try? await api.recordView(clip.id, sessionId: session) }
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        if let loopObserver { NotificationCenter.default.removeObserver(loopObserver) }
        loopObserver = nil
        player?.pause()
        player = nil
        isPaused = false
    }

    func togglePause() {
        guard let player else { return }
        if player.timeControlStatus == .paused {
            player.play()
            isPaused = false
        } else {
            player.pause()
            isPaused = true
        }
    }

    func setMuted(_ muted: Bool) {
        player?.isMuted = muted
    }

    private static func url(for clip: Asset, api: APIClient) async -> URL? {
        let ext = ((clip.filePath ?? clip.title ?? "") as NSString).pathExtension.lowercased()
        if ["mp4", "m4v", "mov"].contains(ext) {
            return api.url("/api/v1/assets/\(APIClient.segment(clip.id))/file")
        }
        for _ in 0..<30 {
            guard let (info, status) = try? await api.prepareStream(clip.id) else { return nil }
            if status != 202 || info.status == "ready" {
                return api.url(PlaybackPlanner.plan(info: info, assetId: clip.id, startSeconds: 0).path)
            }
            try? await Task.sleep(for: .seconds(1))
            if Task.isCancelled { return nil }
        }
        return nil
    }
}

/// An `AVPlayerLayer` that fills its frame, by default cropping like a vertical video app.
struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer
    /// `.resizeAspect` shows the whole picture with bars instead of cropping (Apple TV).
    var gravity: AVLayerVideoGravity = .resizeAspectFill

    func makeUIView(context: Context) -> LayerView {
        let view = LayerView()
        view.playerLayer.videoGravity = gravity
        view.playerLayer.player = player
        return view
    }

    func updateUIView(_ view: LayerView, context: Context) {
        if view.playerLayer.player !== player { view.playerLayer.player = player }
        if view.playerLayer.videoGravity != gravity { view.playerLayer.videoGravity = gravity }
    }

    final class LayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}
