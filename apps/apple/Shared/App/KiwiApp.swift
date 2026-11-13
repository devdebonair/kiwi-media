import AVFoundation
import SwiftUI

@main
struct KiwiApp: App {
    #if os(iOS)
    @UIApplicationDelegateAdaptor(KiwiAppDelegate.self) private var appDelegate
    #endif
    @State private var app = AppModel()

    init() {
        // Lets video keep playing in Picture in Picture and over AirPlay, and ignore the ring/silent switch.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .environment(app.api)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            switch app.phase {
            case .launching:
                ZStack {
                    Theme.background.ignoresSafeArea()
                    ProgressView().controlSize(.large)
                }
            case let .needsServer(message):
                ServerSetupView(message: message)
            case .choosingProfile:
                ProfilePickerView()
            case let .ready(profile):
                MainView(profile: profile)
                    .id(profile.id)
            }
        }
        .task { await app.bootstrap() }
    }
}
