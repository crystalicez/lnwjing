// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "LnwjingMacHost",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "lnwjing-macos-host", targets: ["LnwjingMacHost"]),
    ],
    targets: [
        .executableTarget(name: "LnwjingMacHost"),
        .testTarget(name: "LnwjingMacHostTests", dependencies: ["LnwjingMacHost"]),
    ]
)
