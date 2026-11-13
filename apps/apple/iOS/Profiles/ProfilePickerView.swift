import SwiftUI

/// "Who's watching?" Locked profiles ask for their 4-digit PIN.
struct ProfilePickerView: View {
    @Environment(AppModel.self) private var app
    @State private var pinProfile: Profile?
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 40) {
                    Text("Who's watching?")
                        .font(.title.weight(.bold))
                        .padding(.top, 40)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), spacing: 24)], spacing: 28) {
                        ForEach(app.profiles) { profile in
                            Button {
                                choose(profile)
                            } label: {
                                VStack(spacing: 10) {
                                    ProfileAvatar(profile: profile, size: 110)
                                    HStack(spacing: 6) {
                                        Text(profile.name).font(.headline)
                                        if profile.locked {
                                            Image(systemName: "lock.fill").font(.caption)
                                        }
                                    }
                                    .foregroundStyle(Theme.secondaryText)
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityElement(children: .ignore)
                            .accessibilityAddTraits(.isButton)
                            .accessibilityLabel(profile.locked ? "\(profile.name), locked" : profile.name)
                        }
                    }
                    .padding(.horizontal, 32)
                    if let error {
                        Text(error)
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }
                }
            }
            .overlay {
                if !loaded { ProgressView().controlSize(.large) }
            }
            .background(Theme.background.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Change Server", systemImage: "server.rack") { app.changeServer() }
                }
            }
        }
        .task {
            if app.profiles.isEmpty { await app.loadProfiles() }
            if app.profiles.isEmpty { error = "Couldn't load profiles from \(app.serverDescription)." }
            loaded = true
        }
        .sheet(item: $pinProfile) { profile in
            PinEntryView(profile: profile)
                .presentationDetents([.large])
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
