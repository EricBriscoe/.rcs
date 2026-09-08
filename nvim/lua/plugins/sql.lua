-- SQL: sqlfluff formats on save with the Postgres dialect and reports no
-- diagnostics (it is too noisy on legacy migrations). Migration deltas are
-- append-only history and are never reformatted. dadbod-ui connections are
-- built on demand from util/project.lua's db_sources so a worktree can point
-- at its own database.
local project = require("util.project")

local augroup = vim.api.nvim_create_augroup("user_sql", { clear = true })

vim.api.nvim_create_autocmd({ "BufReadPre", "BufNewFile" }, {
  group = augroup,
  pattern = "*/db/deltas/*.sql",
  callback = function(event)
    vim.b[event.buf].autoformat = false
  end,
})

local function refresh_dbs()
  local dbs = project.dbs()
  if vim.deep_equal(dbs, vim.g.dbs or {}) then
    return
  end
  vim.g.dbs = dbs
  -- dadbod-ui reads g:dbs only when it creates its singleton; drop it so the
  -- next open picks up the new connections. A no-op until the plugin loads.
  pcall(vim.fn["db_ui#reset_state"])
end

vim.api.nvim_create_autocmd({ "VimEnter", "DirChanged" }, {
  group = augroup,
  callback = refresh_dbs,
})

return {
  {
    "stevearc/conform.nvim",
    optional = true,
    opts = function(_, opts)
      opts.formatters = opts.formatters or {}
      opts.formatters.sqlfluff = opts.formatters.sqlfluff or {}
      opts.formatters.sqlfluff.args = { "format", "--dialect=postgres", "-" }
      -- Let the global ~/.config/sqlfluff config apply outside projects too.
      opts.formatters.sqlfluff.require_cwd = false
    end,
  },
  {
    "mfussenegger/nvim-lint",
    optional = true,
    opts = function(_, opts)
      for _, ft in ipairs({ "sql", "mysql", "plsql" }) do
        opts.linters_by_ft[ft] = vim.tbl_filter(function(name)
          return name ~= "sqlfluff"
        end, opts.linters_by_ft[ft] or {})
      end
    end,
  },
  {
    "kristijanhusak/vim-dadbod-ui",
    optional = true,
    keys = {
      {
        "<leader>D",
        function()
          refresh_dbs()
          vim.cmd("DBUIToggle")
        end,
        desc = "Toggle DBUI",
      },
    },
  },
}
