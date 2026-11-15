import AVFoundation
import SwiftUI

/// The Live tab's player. One `PlayerSession` plays the tuned channel in two places: a preview above the guide,
/// so viewers can keep looking at what's on while they watch, and full screen. Going back from full screen
/// returns to the guide without interrupting the channel, the way turning an iPhone upright does.
@Observable
final class LivePlayer {
    private(set) var session: PlayerSession?
    /// The channel fills the screen (in the system player) instead of playing above the guide.
    var isFullscreen = false

    var isActive: Bool { session != nil }
    var channelKey: String? { session?.channelKey }

    /// The channel watched most recently, which the Live tab tunes to when it opens.
    static var lastChannel: String? {
        get { UserDefaults.standard.string(forKey: "live.lastChannel") }
        set { UserDefaults.standard.set(newValue, forKey: "live.lastChannel") }
    }

    /// Starts watching `key`, or switches to it if something is already playing.
    func tune(_ key: String, api: APIClient) {
        Self.lastChannel = key
        if let session {
            if session.channelKey != key {
                session.tune(to: key)
            } else if case .failed = session.phase {
                session.start()
            }
            return
        }
        let session = PlayerSession(api: api, request: PlayRequest(source: .channel(key)))
        self.session = session
        session.start()
    }

    func togglePlayback() {
        guard let player = session?.player else { return }
        if player.timeControlStatus == .paused { player.play() } else { player.pause() }
    }

    /// Ends playback and releases the player. Safe to call more than once.
    func stop() {
        isFullscreen = false
        session?.stop()
        session = nil
    }
}
