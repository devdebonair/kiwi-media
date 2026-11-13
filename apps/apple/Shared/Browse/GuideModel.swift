import Foundation

/// The channel guide: every channel with its programs over the next few hours, refreshed as time passes.
@Observable
final class GuideModel {
    enum State: Equatable { case loading, loaded, empty, failed(String) }

    private(set) var state: State = .loading
    private(set) var channels: [Channel] = []
    /// Server time (ms) for progress bars and "airing now"; advanced by `tick()`.
    private(set) var now = GuideClock.now
    /// Start of the window the guide covers (the current half hour), for laying out a timeline.
    private(set) var windowStart = GuideClock.now

    func refresh(_ api: APIClient) async {
        do {
            let guide = try await api.guide(hours: 4, limit: 100)
            channels = guide.channels
            windowStart = (guide.now / 1_800_000).rounded(.down) * 1_800_000
            now = GuideClock.now
            state = channels.isEmpty ? .empty : .loaded
        } catch {
            if channels.isEmpty { state = .failed(error.localizedDescription) }
        }
    }

    /// Moves the clock on; refetches once programs that were airing have ended.
    func tick(_ api: APIClient) async {
        now = GuideClock.now
        let stale = channels.contains { channel in channel.airing(at: now) == nil && !channel.programs.isEmpty }
        if stale || now - windowStart > 3_600_000 { await refresh(api) }
    }
}
