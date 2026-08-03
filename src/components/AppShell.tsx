import { useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  AppBar,
  Box,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Typography,
} from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import AppsIcon from "@mui/icons-material/Apps";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import DnsIcon from "@mui/icons-material/Dns";
import TerminalIcon from "@mui/icons-material/Terminal";
import MonitorHeartIcon from "@mui/icons-material/MonitorHeart";
import LogoutIcon from "@mui/icons-material/Logout";
import ThemeToggle from "./ThemeToggle";
import { useAuth } from "../contexts/AuthContext";

const DRAWER_WIDTH = 220;

const NAV_ITEMS = [
  { label: "Services", path: "/", icon: <AppsIcon /> },
  { label: "Deploys", path: "/deploys", icon: <RocketLaunchIcon /> },
  { label: "Instances", path: "/instances", icon: <DnsIcon /> },
  { label: "Logs", path: "/logs", icon: <TerminalIcon /> },
  { label: "Node stats", path: "/stats", icon: <MonitorHeartIcon /> },
];

export default function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { signOut } = useAuth();

  const drawer = (
    <List>
      {NAV_ITEMS.map((item) => (
        <ListItemButton
          key={item.path}
          selected={location.pathname === item.path}
          onClick={() => {
            navigate(item.path);
            setMobileOpen(false);
          }}
        >
          <ListItemIcon>{item.icon}</ListItemIcon>
          <ListItemText primary={item.label} />
        </ListItemButton>
      ))}
    </List>
  );

  return (
    <Box sx={{ display: "flex" }}>
      <AppBar position="fixed" sx={{ zIndex: (t) => t.zIndex.drawer + 1 }}>
        <Toolbar>
          <IconButton
            color="inherit"
            edge="start"
            sx={{ mr: 2, display: { sm: "none" } }}
            onClick={() => setMobileOpen(!mobileOpen)}
          >
            <MenuIcon />
          </IconButton>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            gateway-api
          </Typography>
          <ThemeToggle />
          <IconButton color="inherit" onClick={signOut} title="Sign out">
            <LogoutIcon />
          </IconButton>
        </Toolbar>
      </AppBar>

      <Drawer
        variant="temporary"
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        ModalProps={{ keepMounted: true }}
        sx={{
          display: { xs: "block", sm: "none" },
          "& .MuiDrawer-paper": { width: DRAWER_WIDTH },
        }}
      >
        <Toolbar />
        {drawer}
      </Drawer>
      <Drawer
        variant="permanent"
        sx={{
          display: { xs: "none", sm: "block" },
          width: DRAWER_WIDTH,
          flexShrink: 0,
          "& .MuiDrawer-paper": { width: DRAWER_WIDTH, boxSizing: "border-box" },
        }}
        open
      >
        <Toolbar />
        {drawer}
      </Drawer>

      <Box component="main" sx={{ flexGrow: 1, p: 3 }}>
        <Toolbar />
        <Outlet />
      </Box>
    </Box>
  );
}
