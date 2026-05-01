-- LODAS gives each git worktree its own Postgres container on a port
-- written into that worktree's .env (DB_HOST_PORT). Discover it from
-- the cwd's worktree root and build the dadbod connection string.

local function find_dotenv()
  local start = vim.fn.expand("%:p:h")
  if start == "" then
    start = vim.fn.getcwd()
  end
  return vim.fs.find(".env", { upward = true, path = start, type = "file" })[1]
end

local function read_db_port(env_file)
  if not env_file then
    return nil
  end
  for line in io.lines(env_file) do
    local port = line:match("^DB_HOST_PORT=(%d+)")
    if port then
      return port
    end
  end
end

local function lodas_dbs()
  local port = read_db_port(find_dotenv()) or "5432"
  return {
    lodas = "postgres://realto:password@localhost:" .. port .. "/realto",
  }
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
          vim.g.dbs = lodas_dbs()
          vim.cmd("DBUIToggle")
        end,
        desc = "Toggle DB UI",
      },
    },
    init = function()
      vim.g.db_ui_use_nerd_fonts = 1
      vim.g.db_ui_show_database_icon = 1
      vim.g.db_ui_force_echo_notifications = 1
      vim.g.dbs = lodas_dbs()
    end,
  },
}
