import Foundation
import SwiftUI

/// Something to play: an asset (resuming where the viewer left off) or a live channel. Each request gets its
/// own id, so asking to play the same thing again re-presents the player.
struct PlayRequest: Identifiable, Hashable {
    enum Source: Hashable {
        case asset(String, startOver: Bool)
        case channel(String)
    }

    let id = UUID()
    let source: Source
}

@Observable
final class AppModel {
    enum Phase: Equatable {
        case launching
        case needsServer(message: String?)
        case choosingProfile
        case ready(Profile)
    }

    private(set) var phase: Phase = .launching
    private(set) var profiles: [Profile] = []
    var playRequest: PlayRequest?
    /// Bumped whenever the player closes, so screens can refresh Continue Watching and progress bars.
    private(set) var playbackGeneration = 0

    let api: APIClient

    private static let serverKey = "kiwi.serverURL"

    init() {
        api = APIClient(baseURL: Self.storedServer())
        api.onProfileRequired = { [weak self] in
            guard let self, case .ready = self.phase else { return }
            self.phase = .choosingProfile
            Task { await self.loadProfiles() }
        }
    }

    var currentProfile: Profile? {
        if case let .ready(profile) = phase { return profile }
        return nil
    }

    var serverDescription: String { api.baseURL?.absoluteString ?? "Not set" }

    // MARK: Startup

    func bootstrap() async {
        guard api.baseURL != nil else {
            phase = .needsServer(message: nil)
            return
        }
        do {
            phase = .ready(try await api.session())
        } catch APIError.profileRequired {
            phase = .choosingProfile
            await loadProfiles()
        } catch {
            phase = .needsServer(message: "Couldn't reach \(serverDescription). \(error.localizedDescription)")
        }
    }

    /// Checks that `text` points at a Kiwi server, then remembers it.
    func connect(to text: String) async throws {
        var trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.contains("://") { trimmed = "http://" + trimmed }
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard let url = URL(string: trimmed), url.host != nil else {
            throw APIError.http(status: 0, message: "That doesn't look like a server address.", code: nil)
        }
        let previous = api.baseURL
        api.setBaseURL(url)
        do {
            let health = try await api.health()
            guard health.service == "kiwi" else {
                throw APIError.http(status: 0, message: "That server isn't running Kiwi.", code: nil)
            }
        } catch {
            api.setBaseURL(previous)
            throw error
        }
        UserDefaults.standard.set(url.absoluteString, forKey: Self.serverKey)
        await bootstrap()
    }

    func changeServer() {
        phase = .needsServer(message: nil)
    }

    // MARK: Profiles

    func loadProfiles() async {
        if let response = try? await api.profiles() {
            profiles = response.profiles
        }
    }

    func select(_ profile: Profile, pin: String?) async throws {
        let selected = try await api.selectProfile(profile.id, pin: pin)
        phase = .ready(selected)
    }

    func switchProfile() async {
        playRequest = nil
        try? await api.signOut()
        phase = .choosingProfile
        await loadProfiles()
    }

    // MARK: Playback

    func play(_ assetId: String, startOver: Bool = false) {
        playRequest = PlayRequest(source: .asset(assetId, startOver: startOver))
    }

    /// Joins a channel live, at whatever is airing now.
    func tune(_ channel: String) {
        playRequest = PlayRequest(source: .channel(channel))
    }

    /// Plays a title's next-up asset (the movie, or the episode to resume), looking it up first.
    func playTitle(_ ref: String) async {
        if let next = try? await api.title(ref).nextUp {
            play(next.id)
        }
    }

    func playerClosed() {
        playbackGeneration += 1
    }

    private static func storedServer() -> URL? {
        if let saved = UserDefaults.standard.string(forKey: serverKey), let url = URL(string: saved) {
            return url
        }
        #if targetEnvironment(simulator)
        // The simulator shares the Mac's network, so a locally running API is the obvious default.
        return URL(string: "http://localhost:3333")
        #else
        return nil
        #endif
    }
}
