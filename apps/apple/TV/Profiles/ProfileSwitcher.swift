import SwiftUI

/// Netflix's quick profile switch: a small glass panel under the top bar listing every profile, the current one
/// ticked. Picking another switches to it straight away, with no trip back to "Who's watching?". A locked
/// profile asks for its PIN first (`onLocked`), and the server checks that PIN on every switch. Back closes the
/// panel without switching.
struct ProfileSwitcher: View {
    let current: Profile
    /// Called with a locked profile; the caller asks for its PIN.
    let onLocked: (Profile) -> Void
    let onClose: () -> Void

    @Environment(AppModel.self) private var app
    @State private var error: String?
    @State private var switching: String?
    @FocusState private var focused: String?

    private static let changeServer = "change-server"

    /// Where focus starts: the first profile that isn't this one, since that's the one most likely wanted.
    private var firstOther: String? {
        app.profiles.first { $0.id != current.id }?.id ?? current.id
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if app.profiles.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 30)
            }
            ForEach(app.profiles) { profile in
                Button {
                    choose(profile)
                } label: {
                    ProfileRow(profile: profile, isCurrent: profile.id == current.id, isSwitching: switching == profile.id)
                }
                .buttonStyle(SwitcherRowStyle())
                .focused($focused, equals: profile.id)
                .disabled(switching != nil)
            }
            if let error {
                Text(error)
                    .font(.system(size: 22))
                    .foregroundStyle(.red)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 6)
            }
            Divider()
                .overlay(.white.opacity(0.15))
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
            Button {
                onClose()
                app.changeServer()
            } label: {
                Label("Change Server", systemImage: "server.rack")
                    .font(.system(size: 26, weight: .medium))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 20)
                    .frame(height: 64)
            }
            .buttonStyle(SwitcherRowStyle())
            .focused($focused, equals: Self.changeServer)
            .disabled(switching != nil)
        }
        .padding(14)
        .frame(width: 520)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 34, style: .continuous))
        .focusSection()
        .defaultFocus($focused, firstOther)
        .onExitCommand(perform: onClose)
        .task {
            // Fresh each time, so profiles added or locked since launch show up as they are now.
            await app.loadProfiles()
            if focused == nil { focused = firstOther }
        }
    }

    private func choose(_ profile: Profile) {
        error = nil
        if profile.id == current.id {
            onClose()
        } else if profile.locked {
            onLocked(profile)
        } else {
            switching = profile.id
            Task {
                do {
                    try await app.select(profile, pin: nil)
                } catch {
                    self.error = error.localizedDescription
                    switching = nil
                }
            }
        }
    }
}

private struct ProfileRow: View {
    let profile: Profile
    let isCurrent: Bool
    let isSwitching: Bool

    var body: some View {
        HStack(spacing: 18) {
            ProfileAvatar(profile: profile, size: 56)
            Text(profile.name)
                .font(.system(size: 28, weight: isCurrent ? .bold : .medium))
                .lineLimit(1)
            Spacer(minLength: 0)
            if isSwitching {
                ProgressView()
            } else if isCurrent {
                Image(systemName: "checkmark").font(.system(size: 24, weight: .bold))
            } else if profile.locked {
                Image(systemName: "lock.fill").font(.system(size: 22))
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 76)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([profile.name, isCurrent ? "current" : nil, profile.locked ? "locked" : nil].compactMap { $0 }.joined(separator: ", "))
    }
}

/// A row in the panel: plain until focused, then a white pill with dark text, as in Netflix's and the Apple TV
/// app's menus.
private struct SwitcherRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        RowBody(configuration: configuration)
    }

    private struct RowBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isFocused) private var isFocused

        var body: some View {
            configuration.label
                .foregroundStyle(isFocused ? Color.black : Color.white)
                .background(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(isFocused ? Color.white : Color.clear)
                )
                .scaleEffect(configuration.isPressed ? 0.98 : 1)
                .animation(.easeOut(duration: 0.15), value: isFocused)
        }
    }
}
