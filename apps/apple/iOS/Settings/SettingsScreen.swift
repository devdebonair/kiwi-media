import SwiftUI

/// Settings kept on this device only (not on the server), read with `@AppStorage`.
enum PlaybackPreferences {
    /// Double-tapping the left or right side of the video skips back or forward.
    static let doubleTapToSkipKey = "playback.doubleTapToSkip"
    /// Seconds a skip moves, for double-taps and the skip buttons alike.
    static let skipIntervalKey = "playback.skipInterval"
    static let defaultSkipInterval = 10
    /// Intervals with matching `gobackward.N` / `goforward.N` symbols.
    static let skipIntervals = [5, 10, 15, 30]
}

/// The app's own settings, opened from the profile menu.
struct SettingsScreen: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(PlaybackPreferences.doubleTapToSkipKey) private var doubleTapToSkip = true
    @AppStorage(PlaybackPreferences.skipIntervalKey) private var skipInterval = PlaybackPreferences.defaultSkipInterval

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("Double-Tap to Skip", isOn: $doubleTapToSkip)
                    Picker("Skip Interval", selection: $skipInterval) {
                        ForEach(PlaybackPreferences.skipIntervals, id: \.self) { seconds in
                            Text("\(seconds) seconds").tag(seconds)
                        }
                    }
                } header: {
                    Text("Playback")
                } footer: {
                    Text("Double-tap the left or right side of the video to go back or forward. The skip buttons in the player use the same interval. These settings apply to this device only.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

#Preview {
    SettingsScreen()
}
