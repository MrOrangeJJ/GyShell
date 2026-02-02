import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'path'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        },
        output: {
          format: 'cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer_v2'),
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer_v2')
      }
    },
    css: {
      preprocessorOptions: {
        scss: {
          // Silence Dart Sass deprecations triggered by tooling (Vite's integration).
          silenceDeprecations: ['legacy-js-api', 'import']
          // Also suppress deprecation warnings via logger (works across sass versions).
          ,
          logger: {
            warn(message: string, options: any) {
              if (options?.deprecation) return
              // keep non-deprecation warnings
              console.warn(message)
            },
            debug() {
              // noop
            }
          } as any
        }
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer_v2/index.html')
        }
      }
    }
  }
})

