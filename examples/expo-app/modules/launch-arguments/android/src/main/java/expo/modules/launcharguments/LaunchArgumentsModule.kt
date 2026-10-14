package expo.modules.launcharguments

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LaunchArgumentsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LaunchArguments")

    Function("string") { name: String ->
      appContext.currentActivity?.intent?.getStringExtra(name)
    }
  }
}
