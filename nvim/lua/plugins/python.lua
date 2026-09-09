-- Python: basedpyright and ruff resolved per project root. The interpreter
-- and the ruff binary come from the project's virtualenv (util/project.lua),
-- so every worktree of a repository shares one venv and uses the ruff version
-- the repository's setup installs there. Mason's ruff is only the fallback for
-- projects whose venv has none.
local project = require("util.project")

return {
  {
    "neovim/nvim-lspconfig",
    opts = {
      servers = {
        basedpyright = {
          settings = {
            basedpyright = {
              analysis = {
                -- basedpyright defaults to "recommended", which is far stricter
                -- than pyright. A project's pyrightconfig.json still wins.
                typeCheckingMode = "basic",
                diagnosticMode = "openFilesOnly",
              },
            },
          },
          before_init = function(_, config)
            local python = project.venv_bin(config.root_dir, "python")
            if python then
              -- Mutated in place: the client already holds this settings table.
              config.settings.python =
                vim.tbl_deep_extend("force", config.settings.python or {}, { pythonPath = python })
            end
          end,
        },
        ruff = {
          cmd = function(dispatchers, config)
            local ruff = project.venv_bin(config.root_dir, "ruff") or "ruff"
            return vim.lsp.rpc.start({ ruff, "server" }, dispatchers, {
              cwd = config.root_dir,
              env = { RUFF_TRACE = "messages" },
            })
          end,
        },
      },
    },
  },
  {
    -- Save runs ruff's auto-fixes and then its formatter, the same pair the
    -- repository's pre-commit hook runs, using the venv's ruff.
    "stevearc/conform.nvim",
    optional = true,
    opts = function(_, opts)
      local function venv_ruff(_, ctx)
        return project.venv_bin(project.python_root(ctx.dirname), "ruff") or "ruff"
      end
      opts.formatters_by_ft.python = { "ruff_fix", "ruff_format" }
      opts.formatters = opts.formatters or {}
      opts.formatters.ruff_fix = vim.tbl_deep_extend("force", opts.formatters.ruff_fix or {}, { command = venv_ruff })
      opts.formatters.ruff_format =
        vim.tbl_deep_extend("force", opts.formatters.ruff_format or {}, { command = venv_ruff })
    end,
  },
  {
    "nvim-neotest/neotest",
    optional = true,
    opts = {
      adapters = {
        ["neotest-python"] = {
          runner = "pytest",
          python = function(root)
            return project.venv_bin(root, "python") or "python3"
          end,
        },
      },
    },
  },
}
