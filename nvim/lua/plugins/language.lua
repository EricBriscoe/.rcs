local lodas_root = "/Users/eric/dev/lodas"
local lodas_biome = lodas_root .. "/node_modules/.bin/biome"
local lodas_python = "/Users/eric/.venvs/lodas/bin/python"
local lodas_ruff = "/Users/eric/.venvs/lodas/bin/ruff"

local function executable(path)
  return vim.fn.executable(path) == 1
end

local function command(preferred, fallback)
  if executable(preferred) then
    return preferred
  end

  return fallback
end

local function format_enabled(bufnr)
  if vim.g.disable_autoformat or vim.b[bufnr].disable_autoformat then
    return false
  end

  local filetypes = {
    bash = true,
    css = true,
    javascript = true,
    javascriptreact = true,
    json = true,
    jsonc = true,
    lua = true,
    markdown = true,
    python = true,
    sh = true,
    sql = true,
    terraform = true,
    tf = true,
    typescript = true,
    typescriptreact = true,
  }

  if not filetypes[vim.bo[bufnr].filetype] then
    return false
  end

  -- LODAS deltas are append-only history; never reformat them.
  if vim.bo[bufnr].filetype == "sql" then
    if vim.api.nvim_buf_get_name(bufnr):match("/db/deltas/") then
      return false
    end
  end

  return true
end

local function format_on_save(bufnr)
  if not format_enabled(bufnr) then
    return
  end

  return {
    timeout_ms = 3000,
    lsp_format = "fallback",
  }
end

return {
  {
    "folke/which-key.nvim",
    event = "VeryLazy",
    opts = {
      preset = "modern",
      spec = {
        { "<leader>c", group = "code" },
        { "<leader>d", group = "diagnostics" },
        { "<leader>f", group = "format" },
        { "<leader>g", group = "git" },
        { "<leader>r", group = "rename" },
        { "<leader>s", group = "search" },
        { "<leader>t", group = "terminal" },
        { "<leader>u", group = "ui toggles" },
        { "<leader>w", group = "workspace" },
      },
    },
  },
  {
    "folke/lazydev.nvim",
    ft = "lua",
    opts = {
      library = {
        { path = "${3rd}/luv/library", words = { "vim%.uv" } },
      },
    },
  },
  {
    "saghen/blink.cmp",
    version = "1.*",
    dependencies = {
      "rafamadriz/friendly-snippets",
    },
    opts = {
      keymap = {
        preset = "default",
      },
      completion = {
        documentation = {
          auto_show = true,
          auto_show_delay_ms = 250,
        },
      },
      sources = {
        default = { "lsp", "path", "snippets", "buffer" },
      },
    },
  },
  {
    "mason-org/mason.nvim",
    opts = {},
  },
  {
    "WhoIsSethDaniel/mason-tool-installer.nvim",
    dependencies = {
      "mason-org/mason.nvim",
    },
    opts = {
      ensure_installed = {
        "actionlint",
        "bash-language-server",
        "basedpyright",
        "docker-compose-language-service",
        "dockerfile-language-server",
        "json-lsp",
        "lua-language-server",
        "marksman",
        "shellcheck",
        "shfmt",
        "sqlfluff",
        "stylua",
        "terraform-ls",
        "tflint",
        "vtsls",
        "yaml-language-server",
      },
      run_on_start = true,
      start_delay = 3000,
    },
  },
  {
    "neovim/nvim-lspconfig",
    dependencies = {
      "saghen/blink.cmp",
      "mason-org/mason.nvim",
    },
    config = function()
      local capabilities = require("blink.cmp").get_lsp_capabilities()
      capabilities.workspace = capabilities.workspace or {}
      capabilities.workspace.didChangeWatchedFiles = {
        dynamicRegistration = false,
      }

      vim.api.nvim_create_autocmd("LspAttach", {
        callback = function(event)
          local function map(mode, lhs, rhs, desc)
            vim.keymap.set(mode, lhs, rhs, { buffer = event.buf, desc = desc, silent = true })
          end

          map("n", "K", vim.lsp.buf.hover, "Hover documentation")
          map("n", "gd", vim.lsp.buf.definition, "Go to definition")
          map("n", "gD", vim.lsp.buf.declaration, "Go to declaration")
          map("n", "gi", vim.lsp.buf.implementation, "Go to implementation")
          map("n", "gr", vim.lsp.buf.references, "Find references")
          map("n", "<leader>rn", vim.lsp.buf.rename, "Rename symbol")
          map({ "n", "v" }, "<leader>ca", vim.lsp.buf.code_action, "Code action")
          map("n", "<leader>ds", vim.lsp.buf.document_symbol, "Document symbols")
          map("n", "<leader>ws", vim.lsp.buf.workspace_symbol, "Workspace symbols")
          map("n", "[d", vim.diagnostic.goto_prev, "Previous diagnostic")
          map("n", "]d", vim.diagnostic.goto_next, "Next diagnostic")
        end,
      })

      vim.lsp.config("*", {
        capabilities = capabilities,
      })

      vim.lsp.config("ruff", {
        cmd = { command(lodas_ruff, "ruff"), "server" },
        init_options = {
          settings = {
            lineLength = 100,
          },
        },
      })

      vim.lsp.config("basedpyright", {
        settings = {
          basedpyright = {
            analysis = {
              autoSearchPaths = true,
              diagnosticMode = "openFilesOnly",
              exclude = {
                "**/.git",
                "**/.pytest_cache",
                "**/.ruff_cache",
                "**/__pycache__",
                "**/build",
                "**/coverage",
                "**/dist",
                "**/htmlcov",
                "**/node_modules",
              },
              typeCheckingMode = "basic",
              useLibraryCodeForTypes = true,
            },
          },
          python = {
            pythonPath = executable(lodas_python) and lodas_python or nil,
          },
        },
      })

      vim.lsp.config("vtsls", {
        settings = {
          vtsls = {
            autoUseWorkspaceTsdk = true,
          },
          typescript = {
            tsserver = {
              maxTsServerMemory = 4096,
            },
          },
        },
      })

      vim.lsp.config("biome", {
        cmd = { command(lodas_biome, "biome"), "lsp-proxy" },
        root_dir = function(bufnr, on_dir)
          local root = vim.fs.root(bufnr, {
            { "biome.json", "biome.jsonc" },
            { "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "deno.lock" },
            { ".git" },
          })

          if root then
            on_dir(root)
          end
        end,
      })

      vim.lsp.config("lua_ls", {
        settings = {
          Lua = {
            diagnostics = {
              globals = { "vim" },
            },
            workspace = {
              checkThirdParty = false,
            },
          },
        },
      })

      vim.lsp.config("yamlls", {
        settings = {
          yaml = {
            keyOrdering = false,
            schemas = {
              ["https://json.schemastore.org/github-workflow.json"] = "/.github/workflows/*.{yml,yaml}",
              ["https://json.schemastore.org/docker-compose.json"] = "docker-compose*.{yml,yaml}",
            },
          },
        },
      })

      vim.lsp.enable({
        "bashls",
        "basedpyright",
        "biome",
        "docker_compose_language_service",
        "dockerls",
        "jsonls",
        "lua_ls",
        "marksman",
        "ruff",
        "terraformls",
        "tflint",
        "vtsls",
        "yamlls",
      })
    end,
  },
  {
    "stevearc/conform.nvim",
    cmd = { "ConformInfo" },
    event = { "BufWritePre" },
    keys = {
      {
        "<leader>f",
        function()
          require("conform").format({ async = true, lsp_format = "fallback" })
        end,
        desc = "Format buffer",
      },
      {
        "<leader>uf",
        function()
          vim.b.disable_autoformat = not vim.b.disable_autoformat
          vim.notify("Autoformat " .. (vim.b.disable_autoformat and "disabled" or "enabled"))
        end,
        desc = "Toggle buffer autoformat",
      },
    },
    opts = {
      format_on_save = format_on_save,
      formatters_by_ft = {
        bash = { "shfmt" },
        css = { "biome" },
        javascript = { "biome" },
        javascriptreact = { "biome" },
        json = { "biome" },
        jsonc = { "biome" },
        lua = { "stylua" },
        markdown = { "injected" },
        python = { "ruff_fix", "ruff_format" },
        sh = { "shfmt" },
        sql = { "sqlfluff" },
        terraform = { "terraform_fmt" },
        tf = { "terraform_fmt" },
        typescript = { "biome" },
        typescriptreact = { "biome" },
      },
      formatters = {
        biome = {
          command = command(lodas_biome, "biome"),
          require_cwd = true,
          cwd = function()
            return vim.fs.root(0, { "biome.json", "biome.jsonc", "package.json" })
          end,
        },
        ruff_fix = {
          command = command(lodas_ruff, "ruff"),
        },
        ruff_format = {
          command = command(lodas_ruff, "ruff"),
        },
        shfmt = {
          prepend_args = { "-i", "4", "-ci" },
        },
        sqlfluff = {
          command = "sqlfluff",
          args = { "format", "--disable-progress-bar", "--nocolor", "--dialect=postgres", "-" },
          stdin = true,
        },
      },
    },
  },
  {
    "mfussenegger/nvim-lint",
    event = { "BufReadPost", "BufWritePost", "InsertLeave" },
    config = function()
      local lint = require("lint")

      lint.linters_by_ft = {
        sh = { "shellcheck" },
        sql = { "sqlfluff" },
        terraform = { "tflint" },
        tf = { "tflint" },
      }

      -- nvim-lint defaults sqlfluff to ANSI dialect; LODAS is Postgres 15.
      lint.linters.sqlfluff.args = {
        "lint",
        "--format=json",
        "--dialect=postgres",
        "-",
      }

      vim.api.nvim_create_autocmd({ "BufReadPost", "BufWritePost", "InsertLeave" }, {
        callback = function(args)
          lint.try_lint()

          local name = vim.api.nvim_buf_get_name(args.buf)
          if name:match("/%.github/workflows/.*%.ya?ml$") then
            lint.try_lint("actionlint")
          end
        end,
      })
    end,
  },
}
