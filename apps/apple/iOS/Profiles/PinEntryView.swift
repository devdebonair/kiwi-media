import SwiftUI

/// A passcode-style 4-digit PIN pad. Submits as soon as the fourth digit is entered.
struct PinEntryView: View {
    let profile: Profile

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var digits = ""
    @State private var message: String?
    @State private var isChecking = false
    @State private var attempts = 0

    private let keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"]

    var body: some View {
        VStack(spacing: 28) {
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
            }
            ProfileAvatar(profile: profile, size: 84)
            Text("Enter the PIN for \(profile.name)")
                .font(.headline)
            HStack(spacing: 20) {
                ForEach(0..<4, id: \.self) { index in
                    Circle()
                        .strokeBorder(.white.opacity(0.7), lineWidth: 1.5)
                        .background(Circle().fill(index < digits.count ? Color.white : .clear))
                        .frame(width: 16, height: 16)
                }
            }
            .phaseAnimator([0, 12, -12, 0], trigger: attempts) { view, offset in
                view.offset(x: offset)
            }
            Text(message ?? " ")
                .font(.footnote)
                .foregroundStyle(.red)
                .multilineTextAlignment(.center)
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(84), spacing: 24), count: 3), spacing: 18) {
                ForEach(keys, id: \.self) { key in
                    if key.isEmpty {
                        Color.clear.frame(width: 76, height: 76)
                    } else {
                        Button {
                            press(key)
                        } label: {
                            Text(key)
                                .font(.system(size: key == "⌫" ? 24 : 32, weight: .regular))
                                .frame(width: 76, height: 76)
                                .background(Circle().fill(key == "⌫" ? Color.clear : Color.white.opacity(0.14)))
                        }
                        .buttonStyle(.plain)
                        .disabled(isChecking)
                        .accessibilityLabel(key == "⌫" ? "Delete" : key)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(24)
        .background(Theme.background.ignoresSafeArea())
        .sensoryFeedback(.error, trigger: attempts)
    }

    private func press(_ key: String) {
        message = nil
        if key == "⌫" {
            if !digits.isEmpty { digits.removeLast() }
            return
        }
        guard digits.count < 4 else { return }
        digits.append(key)
        if digits.count == 4 { submit() }
    }

    private func submit() {
        isChecking = true
        let pin = digits
        Task {
            defer { isChecking = false }
            do {
                try await app.select(profile, pin: pin)
                dismiss()
            } catch {
                digits = ""
                attempts += 1
                message = (error as? APIError)?.code == "pin_locked"
                    ? "Too many tries. Wait a few minutes and try again."
                    : error.localizedDescription
            }
        }
    }
}
