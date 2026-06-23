-- DB connections come from optional machine-local config (lua/local.lua,
-- gitignored). `L.dbs()` returns a { name = connection-url } table. Without a
-- local module, no connections are configured.

local function dbs()
  local ok, L = pcall(require, "local")
  if ok and type(L) == "table" and type(L.dbs) == "function" then
    return L.dbs()
  end
  return {}
end

return {
  { "tpope/vim-dadbod", lazy = true, cmd = "DB" },
  {
    "kristijanhusak/vim-dadbod-ui",
    dependencies = { "tpope/vim-dadbod" },
    cmd = { "DBUI", "DBUIToggle", "DBUIAddConnection", "DBUIFindBuffer" },
    keys = {
      {
        "<leader>D",
        function()
          vim.g.dbs = dbs()
          vim.cmd("DBUIToggle")
        end,
        desc = "Toggle DB UI",
      },
    },
    init = function()
      vim.g.db_ui_use_nerd_fonts = 1
      vim.g.db_ui_show_database_icon = 1
      vim.g.db_ui_force_echo_notifications = 1
      vim.g.dbs = dbs()
    end,
  },
}
