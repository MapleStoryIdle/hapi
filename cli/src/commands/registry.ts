import { hubCommand } from './hub'
import { createCommandResolver } from './registryBase'

export const resolveCommand = createCommandResolver([
    hubCommand,
    { ...hubCommand, name: 'server' }
])
