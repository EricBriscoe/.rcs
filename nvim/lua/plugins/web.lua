-- JavaScript/TypeScript: vtsls for types (LazyVim extra), biome for formatting
-- and lint fixes on save through the project's own binary, and the eslint
-- language server only where the project has eslint installed.
--
-- lspconfig roots biome and eslint at the nearest lock file and then looks for
-- their config *below* that package. In a monorepo that keeps biome.json and
-- .eslintrc.* at the repository root next to node_modules, that never matches,
-- so both roots are resolved at the nearest config file instead.

local eslint_configs = {
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.mjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
  "eslint.config.js",
  "eslint.config.cjs",
  "eslint.config.mjs",
  "eslint.config.ts",
  "eslint.config.cts",
  "eslint.config.mts",
}

--- Nearest directory at or above `dir` with an executable node_modules/.bin/<name>.
---@param dir string
---@param name string
---@return string? dir
---@return string? bin
local function node_bin(dir, name)
  local current = dir
  while current do
    local bin = current .. "/node_modules/.bin/" .. name
    if vim.fn.executable(bin) == 1 then
      return current, bin
    end
    local parent = vim.fs.dirname(current)
    if parent == current then
      break
    end
    current = parent
  end
  return nil
end

return {
  {
    "neovim/nvim-lspconfig",
    opts = function(_, opts)
      opts.servers.biome = vim.tbl_deep_extend("force", opts.servers.biome or {}, {
        -- Never Mason's copy: the nearest node_modules/.bin/biome above the
        -- config, else the globally installed biome on PATH (a bare worktree),
        -- so the version is one the repository chose rather than Mason's latest.
        mason = false,
        root_dir = function(bufnr, on_dir)
          local root = vim.fs.root(bufnr, { "biome.json", "biome.jsonc" })
          if root then
            on_dir(root)
          end
        end,
        cmd = function(dispatchers, config)
          local _, bin = node_bin(config.root_dir or vim.uv.cwd(), "biome")
          return vim.lsp.rpc.start({ bin or "biome", "lsp-proxy" }, dispatchers, { cwd = config.root_dir })
        end,
      })

      local eslint = opts.servers.eslint
      if type(eslint) == "table" and eslint.enabled ~= false then
        eslint.root_dir = function(bufnr, on_dir)
          if vim.fs.root(bufnr, { "deno.json", "deno.jsonc", "deno.lock" }) then
            return
          end
          -- The config says the project uses eslint; the root is wherever
          -- eslint is installed (hoisted in a monorepo). A bare worktree has
          -- the config but no node_modules, and the server would start only
          -- to report it cannot load eslint, so it is not started at all.
          if not vim.fs.root(bufnr, eslint_configs) then
            return
          end
          local root = node_bin(vim.fs.dirname(vim.api.nvim_buf_get_name(bufnr)), "eslint")
          if root then
            on_dir(root)
          end
        end
      end
    end,
  },
}
