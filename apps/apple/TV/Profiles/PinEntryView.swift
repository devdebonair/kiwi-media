import SwiftUI

/// A 4-digit PIN pad driven by the Siri Remote. Submits as soon as the fourth digit is entered.
struct PinEntryView: View {
    let profile: Profile

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var digits = ""
    @State private var message: String?
    @State private var isChecking = false
    @State private var shake = false

    private let rows = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["", "0", "⌫"]]

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            HStack(spacing: 120) {
                VStack(spacing: 36) {
                    ProfileAvatar(profile: profile, size: 180)
                    Text("Enter the PIN for \(profile.name)")
                        .font(.title2.weight(.semibold))
                    HStack(spacing: 28) {
                        ForEach(0..<4, id: \.self) { index in
                            Circle()
                                .strokeBorder(.white.opacity(0.6), lineWidth: 3)
                                .background(Circle().fill(index < digits.count ? Color.white : .clear))
                                .frame(width: 34, height: 34)
                        }
                    }
                    .offset(x: shake ? 18 : 0)
                    .animation(.default.repeatCount(3, autoreverses: true).speed(4), value: shake)
                    Text(message ?? " ")
                        .foregroundStyle(.red)
                        .frame(height: 40)
                }
                .frame(width: 700)

                VStack(spacing: 24) {
                    ForEach(rows, id: \.self) { row in
                        HStack(spacing: 24) {
                            ForEach(row, id: \.self) { key in
                                if key.isEmpty {
                                    Color.clear.frame(width: 140, height: 110)
                                } else {
                                    Button {
                                        press(key)
                                    } label: {
                                        Text(key)
                                            .font(.system(size: 44, weight: .semibold))
                                            .frame(width: 140, height: 110)
                                    }
                                    .buttonStyle(.card)
                                    .disabled(isChecking)
                                }
                            }
                        }
                    }
                }
                .focusSection()
            }
        }
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
                message = (error as? APIError)?.code == "pin_locked"
                    ? "Too many tries. Wait a few minutes and try again."
                    : error.localizedDescription
                shake.toggle()
            }
        }
    }
}
