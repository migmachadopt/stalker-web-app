plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.iptvplayer.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.iptvplayer.tv"
        minSdk = 23
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"

        // Suggested the first time the app opens (it can be changed there)
        buildConfigField("String", "DEFAULT_SERVER", "\"http://192.168.1.159\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Signed with the debug key so the APK can be installed straight away
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    val media3 = "1.5.1"
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    implementation("androidx.media3:media3-ui:$media3")
}
