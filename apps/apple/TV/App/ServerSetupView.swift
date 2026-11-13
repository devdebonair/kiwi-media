import SwiftUI

/// First run (or "Change Server"): where the Kiwi API lives, e.g. `http://100.122.182.74:3333`.
struct ServerSetupView: View {
    let message: String?

    @Environment(AppModel.self) private var app
    @State private var address = ""
    @State private var error: String?
    @State private var isConnecting = false

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()
            VStack(spacing: 40) {
                Text("kiwi")
                    .font(.system(size: 120, weight: .black, design: .rounded))
                    .foregroundStyle(Theme.accent)
                Text("Connect to your Kiwi server")
                    .font(.title2.weight(.semibold))
                Text("Enter the address of the Kiwi API, including its port (usually 3333).")
                    .foregroundStyle(Theme.secondaryText)
                TextField("http://192.168.1.20:3333", text: $address)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .frame(width: 900)
                    .onSubmit(connect)
                Button(isConnecting ? "Connecting…" : "Connect", action: connect)
                    .buttonStyle(PillButtonStyle(prominent: true))
                    .disabled(isConnecting || address.trimmingCharacters(in: .whitespaces).isEmpty)
                if let shown = error ?? message {
                    Text(shown)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 1200)
                }
            }
        }
        .onAppear {
            if address.isEmpty, let current = app.api.baseURL { address = current.absoluteString }
        }
    }

    private func connect() {
        guard !isConnecting else { return }
        error = nil
        isConnecting = true
        Task {
            defer { isConnecting = false }
            do {
                try await app.connect(to: address)
            } catch {
                self.error = "Couldn't connect: \(error.localizedDescription)"
            }
        }
    }
}
