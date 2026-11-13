import SwiftUI

/// "Who's watching?" Locked profiles ask for their 4-digit PIN.
struct ProfilePickerView: View {
    @Environment(AppModel.self) private var app
    @State private var pinProfile: Profile?
    @State private var error: String?
    @State private var loaded = false
    @FocusState private var focusedProfile: String?

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(spacing: 70) {
                Text("Who's watching?")
                    .font(.system(size: 64, weight: .bold))
                if app.profiles.isEmpty {
                    ProgressView().controlSize(.large)
                } else {
                    HStack(spacing: 60) {
                        ForEach(app.profiles) { profile in
                            Button {
                                choose(profile)
                            } label: {
                                ProfileTile(profile: profile)
                            }
                            .buttonStyle(ProfileButtonStyle())
                            .focused($focusedProfile, equals: profile.id)
                        }
                    }
                    .focusSection()
                    .defaultFocus($focusedProfile, app.profiles.first?.id)
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
                // Shown only once profiles have loaded, so focus starts on a profile rather than here.
                if loaded {
                    Button("Change Server") { app.changeServer() }
                        .buttonStyle(PillButtonStyle())
                }
            }
        }
        .task {
            if app.profiles.isEmpty { await app.loadProfiles() }
            if app.profiles.isEmpty { error = "Couldn't load profiles from \(app.serverDescription)." }
            focusedProfile = app.profiles.first?.id
            loaded = true
        }
        .fullScreenCover(item: $pinProfile) { profile in
            PinEntryView(profile: profile)
        }
    }

    private func choose(_ profile: Profile) {
        error = nil
        if profile.locked {
            pinProfile = profile
            return
        }
        Task {
            do {
                try await app.select(profile, pin: nil)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}


private struct ProfileTile: View {
    let profile: Profile

    var body: some View {
        VStack(spacing: 24) {
            ProfileAvatar(profile: profile)
            HStack(spacing: 10) {
                Text(profile.name).font(.title3.weight(.semibold))
                if profile.locked {
                    Image(systemName: "lock.fill").font(.callout)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(profile.locked ? "\(profile.name), locked" : profile.name)
    }
}

private struct ProfileButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        ProfileBody(configuration: configuration)
    }

    private struct ProfileBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isFocused) private var isFocused

        var body: some View {
            configuration.label
                .foregroundStyle(isFocused ? Color.white : Theme.secondaryText)
                .scaleEffect(isFocused ? 1.12 : (configuration.isPressed ? 0.95 : 1))
                .shadow(color: .black.opacity(isFocused ? 0.6 : 0), radius: 24, y: 14)
                .animation(.spring(duration: 0.25), value: isFocused)
        }
    }
}
