import { MAX_UPLOAD_BYTES } from '@hapi/protocol'

// The largest generated image the CLI will serve inline. Must stay in sync with the CLI-side
// limits in cli/src/claude/utils/startHappyServer.ts and cli/src/modules/common/generatedImages.ts.
export const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024

// Generated images and uploaded attachment previews cross the /cli socket as Socket.IO binary
// frames. The engine.io default of 1e6 bytes silently drops any large CLI <-> hub ack frame,
// so an accepted image/blob can never reach the browser (issue #927). Size the buffer to carry
// the largest accepted raw upload plus framing headroom.
export const SOCKET_MAX_HTTP_BUFFER_SIZE = Math.max(64 * 1024 * 1024, MAX_UPLOAD_BYTES + 8 * 1024 * 1024)
